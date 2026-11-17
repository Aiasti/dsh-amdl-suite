import http from 'node:http'
import path from 'node:path'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'

const DEFAULT_WAIT_MS = 180000
const DEFAULT_POLL_MS = 2000
const STATUS_TIMEOUT_MS = 2000

/** 第一版只实现 Windows；差异收在这张表里，其余平台明确拒绝而不是猜参数。 */
const LAUNCHERS = { win32: 'wrapper-lite-qemu.exe' }

const joinFor = (root) => (String(root).includes('\\') ? path.win32 : path.posix)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 启动器参数。第一版只支持 Windows（与 `Start-WrapperLite.ps1` 一致）。
 *
 * @param {string} platform
 * @param {number} port
 * @returns {string[]}
 */
export function launchArgsFor(platform, port) {
  if (platform !== 'win32') throw new Error('only win32 is supported in v1')
  return ['--host-port', String(port), '--memory', '512', '--smp', '2']
}

/**
 * 探测引擎 `/status`。
 *
 * 连不上（连接被拒、超时）或非 200、响应体不是合法 JSON 一律返回 `null`。
 *
 * @param {number} port
 * @param {{ fetchImpl?: (url: string) => Promise<{ status: number, text: () => Promise<string> }> }} [options]
 * @returns {Promise<{ code: number, regions: string[] } | null>}
 */
export async function statusOf(port, options = {}) {
  const fetchImpl = options.fetchImpl ?? httpStatus
  let res
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/status`)
  } catch {
    return null
  }
  if (res?.status !== 200) return null

  let body
  try {
    body = JSON.parse(await res.text())
  } catch {
    return null
  }
  if (body === null || typeof body !== 'object') return null
  if (typeof body.code !== 'number') return null

  const regions = body.data?.regions
  return { code: body.code, regions: Array.isArray(regions) ? regions : [] }
}

/**
 * 确保引擎在跑：已在跑直接复用，否则拉起并轮询到就绪。
 *
 * `regions` 可能为空数组——这不算失败，由调用方判断登录态。
 *
 * @param {{
 *   engineDir: string,
 *   port: number,
 *   platform?: string,
 *   spawnImpl?: (exe: string, args: string[], opts: object) => { pid?: number, unref?: () => void },
 *   fetchImpl?: (url: string) => Promise<{ status: number, text: () => Promise<string> }>,
 *   waitMs?: number,
 *   pollMs?: number,
 * }} options
 * @returns {Promise<{ pid: number | null, regions: string[], reused: boolean }>}
 */
export async function ensureEngine(options) {
  const { engineDir, port } = options
  const platform = options.platform ?? process.platform
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const fetchImpl = options.fetchImpl
  const spawnImpl = options.spawnImpl ?? defaultSpawn

  const first = await statusOf(port, { fetchImpl })
  if (first !== null && first.code === 0) {
    return { pid: null, regions: first.regions, reused: true }
  }

  const j = joinFor(engineDir).join
  const logFile = j(engineDir, 'logs', `engine-${stamp()}.log`)
  const exe = launcherPathFor(engineDir, platform)
  const child = spawnImpl(exe, launchArgsFor(platform, port), {
    detached: true,
    stdio: 'ignore',
    logFile,
  })
  child?.unref?.()
  const pid = child?.pid ?? null

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
    const status = await statusOf(port, { fetchImpl })
    if (status !== null && status.code === 0) {
      return { pid, regions: status.regions, reused: false }
    }
  }

  throw new Error(`引擎在 ${waitMs}ms 内未就绪（端口 ${port}）；日志：${logFile}；目录：${engineDir}`)
}

/**
 * 停引擎，幂等：进程已经不在也当成功。
 *
 * Windows 用 `taskkill /T /F /PID`（连子进程树一起）；其余平台按信号终止。
 *
 * @param {number | null} pid
 * @returns {Promise<void>}
 */
export async function stopEngine(pid) {
  if (pid === null || pid === undefined) return

  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => resolve())
    })
    return
  }

  try {
    process.kill(pid)
  } catch {
    // ESRCH：进程已退出
  }
}

function launcherNameFor(platform) {
  const name = LAUNCHERS[platform]
  if (name === undefined) throw new Error('only win32 is supported in v1')
  return name
}

/**
 * 启动器绝对路径。`engineDir` 既可能是引擎根（`<state>/engine`，产物在其下
 * `wrapper-lite-qemu/`），也可能是产物目录本身；按目录名判断，两种都不猜错。
 */
function launcherPathFor(engineDir, platform) {
  const j = joinFor(engineDir).join
  const name = launcherNameFor(platform)
  return path.basename(String(engineDir).replace(/\\/g, '/')) === 'wrapper-lite-qemu'
    ? j(engineDir, name)
    : j(engineDir, 'wrapper-lite-qemu', name)
}

/** 日志文件名里的时间戳：`2026-11-18T07-40-00-000Z`。 */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** 默认 `spawnImpl`：detached 起启动器，stdout/stderr 落到 `opts.logFile`。 */
function defaultSpawn(exe, args, opts = {}) {
  const logFile = opts.logFile ?? joinFor(exe).join(path.dirname(exe), 'logs', `engine-${stamp()}.log`)
  mkdirSync(path.dirname(logFile), { recursive: true })
  const fd = openSync(logFile, 'a')
  try {
    const child = spawn(exe, args, {
      cwd: path.dirname(exe),
      detached: true,
      stdio: ['ignore', fd, fd],
    })
    child.unref()
    return child
  } finally {
    closeSync(fd)
  }
}

/** 默认 `fetchImpl`：GET `/status`，2 秒超时；形状与注入版一致（`{ status, text }`）。 */
function httpStatus(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: STATUS_TIMEOUT_MS }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode, text: async () => Buffer.concat(chunks).toString('utf8') }),
      )
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`探测超时：${STATUS_TIMEOUT_MS}ms ${url}`)))
    req.on('error', reject)
  })
}
