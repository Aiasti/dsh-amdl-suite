import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import https from 'node:https'
import { pathsFor } from './paths.js'

const NIGHTLY_BASE = 'https://nightly.link/WorldObservationLog/wrapper'
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

/** 引擎四个关键文件，相对 `engine/wrapper-lite-qemu/`。 */
const ENGINE_FILES = [
  'wrapper-lite-qemu.exe',
  'qemu/data.img',
  'qemu/vmlinuz-lite-qemu',
  'qemu/lite-initramfs.cpio.gz',
]

const AMDL_ASSET_NAMES = {
  win32: 'amdl_windows_amd64.exe',
  linux: 'amdl_linux_amd64',
  darwin: 'amdl_darwin_arm64',
}

const platformOf = (options = {}) => options.platform ?? process.platform

const joinFor = (root) => (String(root).includes('\\') ? path.win32 : path.posix)

/** amdl 在状态目录里的落位文件名（Windows 加 `.exe`，其余平台无后缀）。 */
const amdlBinName = (platform) => (platform === 'win32' ? 'amdl.exe' : 'amdl')

/**
 * nightly.link 的 run-id 固定形式。`platform` 不参与 URL——资产名本身已带平台；
 * 这里不提供 `latest` 形式，版本固定才能校验和。
 */
export function assetUrlFor(platform, runId, artifact) {
  return `${NIGHTLY_BASE}/actions/runs/${runId}/${artifact}`
}

/** amdl 发布资产名（按平台）。 */
export function amdlAssetNameFor(platform) {
  const name = AMDL_ASSET_NAMES[platform]
  if (name === undefined) throw new Error(`不支持的平台：${platform}`)
  return name
}

/**
 * 只探测依赖是否就绪，不下载。
 *
 * @param {string} root 状态根目录
 * @param {{ platform?: string }} [options]
 * @returns {Promise<{ engine: { present: boolean, path: string, reason?: string },
 *                     amdl: { present: boolean, path: string, reason?: string } }>}
 */
export async function plan(root, options = {}) {
  const platform = platformOf(options)
  const { engine, bin } = pathsFor(root)
  const j = joinFor(root).join

  const engineFile = j(engine, 'wrapper-lite-qemu', 'wrapper-lite-qemu.exe')
  const amdlFile = j(bin, amdlBinName(platform))
  return {
    engine: await probe(engineFile, `缺少引擎启动器 ${engineFile}`),
    amdl: await probe(amdlFile, `缺少 amdl 可执行文件 ${amdlFile}`),
  }
}

/**
 * 校验已装产物是否完整：引擎四个关键文件齐全非空、amdl 存在且非空。
 *
 * @param {string} root 状态根目录
 * @param {{ platform?: string }} [options]
 * @returns {Promise<{ ok: boolean, items: Array<{ name: string, path: string, size?: number, problem?: string }> }>}
 */
export async function verify(root, options = {}) {
  const platform = platformOf(options)
  const { engine, bin } = pathsFor(root)
  const j = joinFor(root).join
  const engineDir = j(engine, 'wrapper-lite-qemu')

  const items = []
  for (const rel of ENGINE_FILES) {
    const file = j(engineDir, ...rel.split('/'))
    items.push(await check(rel, file))
  }
  const amdlName = amdlBinName(platform)
  const amdlFile = j(bin, amdlName)
  items.push(await check(amdlName, amdlFile))

  return { ok: items.every((item) => item.problem === undefined), items }
}

async function sizeOf(file) {
  try {
    const st = await stat(file)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

/** plan 的单项目状态：存在且非空才算就绪。 */
async function probe(file, missingReason) {
  const size = await sizeOf(file)
  if (size === null) return { present: false, path: file, reason: missingReason }
  if (size === 0) return { present: false, path: file, reason: `文件大小为 0：${file}` }
  return { present: true, path: file }
}

/** verify 的单项目校验：缺失或为空都给中文 problem。 */
async function check(name, file) {
  const size = await sizeOf(file)
  if (size === null) return { name, path: file, problem: `缺少文件 ${file}` }
  if (size === 0) return { name, path: file, size, problem: `文件大小为 0：${file}` }
  return { name, path: file, size }
}

/**
 * 下载到 `<dest>.partial`，成功后 rename 到 `dest`。
 *
 * 已有非空 `.partial` 时带 `Range: bytes=<size>-`：206 追加，200 截断重下。
 *
 * @param {string} url
 * @param {string} dest
 * @param {{
 *   fetchImpl?: (url: string, opts: { headers: Record<string, string> }) =>
 *     Promise<{ status: number, headers?: Record<string, string>,
 *               chunks: Iterable<Buffer> | AsyncIterable<Buffer> }>,
 *   onProgress?: (received: number, total?: number) => void,
 * }} [options]
 *   `fetchImpl` 返回 `{ status, headers?, chunks }`；`chunks` 是响应体字节流，
 *   同步或异步可迭代均可。默认实现用 `node:https` 发 GET 并跟随最多 5 跳重定向。
 * @returns {Promise<{ bytes: number }>} `bytes` 为落盘后的文件总字节数（含续传前已有部分）。
 */
export async function downloadToFile(url, dest, options = {}) {
  const fetchImpl = options.fetchImpl ?? httpGet
  const partial = dest + '.partial'

  await mkdir(path.dirname(dest), { recursive: true })
  const have = (await sizeOf(partial)) ?? 0

  const headers = {}
  if (have > 0) headers.Range = `bytes=${have}-`

  const res = await fetchImpl(url, { headers })
  const append = res.status === 206
  if (!append && res.status !== 200) {
    if (typeof res.chunks?.destroy === 'function') res.chunks.destroy()
    throw new Error(`下载失败：HTTP ${res.status} ${url}`)
  }

  const start = append ? have : 0
  const lengthHeader = res.headers?.['content-length']
  const expected = lengthHeader === undefined ? undefined : start + Number(lengthHeader)

  let received = 0
  async function* counted() {
    for await (const chunk of res.chunks) {
      received += chunk.length
      options.onProgress?.(start + received, expected)
      yield chunk
    }
  }
  // 200 时以 `w` 打开即截断，206 以 `a` 追加
  await pipeline(Readable.from(counted()), createWriteStream(partial, { flags: append ? 'a' : 'w' }))

  await rename(partial, dest)
  return { bytes: start + received }
}

/**
 * 默认 `fetchImpl`：GET（nightly.link 对 HEAD 返回 404），跟随 301/302/303/307/308。
 * 返回 `{ status, headers, chunks }`，`chunks` 即响应流，由调用方消费。
 */
function httpGet(url, opts = {}, hop = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: opts.headers ?? {} }, (res) => {
      const status = res.statusCode
      if (REDIRECT_STATUS.has(status) && res.headers.location !== undefined) {
        res.resume()
        if (hop >= MAX_REDIRECTS) {
          reject(new Error(`重定向超过 ${MAX_REDIRECTS} 跳：${url}`))
          return
        }
        resolve(httpGet(new URL(res.headers.location, url).href, opts, hop + 1))
        return
      }
      resolve({ status, headers: res.headers, chunks: res })
    })
    req.on('error', reject)
  })
}

/** 文件的 SHA256，64 位小写 hex（不带 `sha256:` 前缀）。 */
export function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}