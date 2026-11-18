/**
 * `amdl_setup` 的纯逻辑：`plan` / `fetch-amdl` / `fetch-engine` / `verify`。
 *
 * 本文件属**测试可 import** 的那一层（Ruling 20），所以只 import `node:*` 与同目录
 * `lib/`，**不得** import `@deepseek-ai/*` 或 `../tools/*`——纯 Node 下解析不到。
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import * as realDeps from './deps.js'
import { pathsFor } from './paths.js'

const run = promisify(execFile)

const ACTIONS = ['plan', 'fetch-amdl', 'fetch-engine', 'verify']

const joinFor = (root) => (String(root).includes('\\') ? path.win32 : path.posix)

/** 默认钉住的引擎版本（design §6.6），Config 可覆盖。 */
const ENGINE_RUN_ID = '41577514031'
const ENGINE_SHA256 = 'sha256:67a21f33db9780d081f1a5086f7553b4ab501329be06865647bd01355fae87f1'
const ENGINE_ARTIFACT = 'wrapper-lite-qemu-windows-x86_64.zip'
const ENGINE_BYTES = 157822346
const ENGINE_SECONDS = 225

/**
 * 解压后体积估算：zip 里主要是 `qemu/data.img`（已接近不可压缩），其余是二进制。
 * 真实解压体积只有下载后才知道，这里按 zip 的 3× 取保守上限；盘预检要求可用空间
 * ≥ 该估算 × 1.5。
 */
const ENGINE_UNPACKED_BYTES = ENGINE_BYTES * 3

const AMDL_BASE = 'https://github.com/zhaarey/apple-music-downloader/releases/latest/download'

const LOCK_STALE_MS = 30 * 60 * 1000

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`

/**
 * amdl 在状态目录里的落位文件名。与 `deps.js` 的 `amdlBinName` 同义，但那份未导出，
 * 而本任务只允许改 5 个文件——按 brief 给的二选一，就地按平台拼，不复制资产名表。
 */
const binNameFor = (platform) => (platform === 'win32' ? 'amdl.exe' : 'amdl')

const exists = async (file) => {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** 可用字节；查不到时返回 `null`，由调用方决定是否跳过预检。 */
async function freeBytes(dir) {
  let probe = dir
  for (let i = 0; i < 8; i++) {
    try {
      const s = await statfs(probe)
      return s.bsize * s.bavail
    } catch {
      // 目录可能还不存在：往上找到存在的祖先再查（同一分区）
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  return null
}

const sha256Match = (expected, actual) =>
  String(expected).replace(/^sha256:/i, '').toLowerCase() === String(actual).toLowerCase()

/** `file` 是否落在 `dir` 之内（按同一路径风格比较，Windows 上大小写不敏感）。 */
function isInside(dir, file) {
  if (typeof file !== 'string') return false
  const p = joinFor(dir)
  const rel = p.relative(p.resolve(dir), p.resolve(file))
  return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel)
}

/** 从 `checksums.txt` 文本里取某资产名的 sha256；找不到就报错，不回退成"跳过校验"。 */
function expectedShaFor(text, assetName) {
  for (const line of String(text).split('\n')) {
    const parts = line.trim().split(/\s+/)
    // sha256sum 的二进制模式会在文件名前加 `*`
    if (parts.length >= 2 && parts[1].replace(/^\*/, '') === assetName) return parts[0].toLowerCase()
  }
  throw new Error(`checksums.txt 里没有 ${assetName} 的 sha256，拒绝安装（不做无校验回退）`)
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * 取 `<root>/.setup.lock`。已被占用且持有者仍活着、锁不到 30 分钟 → 直接报错，
 * 不阻塞等待；反之视为崩溃遗留，抢占并在 summary 里说明。
 *
 * @returns {Promise<{ preempted: { pid?: number, time?: number } | null }>}
 */
async function acquireLock(root) {
  const file = joinFor(root).join(root, '.setup.lock')
  await mkdir(root, { recursive: true })
  const mine = JSON.stringify({ pid: process.pid, time: Date.now() })

  try {
    await writeFile(file, mine, { flag: 'wx' })
    return { preempted: null }
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }

  let holder = null
  try {
    holder = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    holder = null
  }

  const age = Date.now() - Number(holder?.time ?? 0)
  const stale = !processAlive(Number(holder?.pid)) || !(age < LOCK_STALE_MS)
  if (!stale) {
    throw new Error(`另一个 amdl_setup 正在运行（pid ${holder?.pid}），请等待其结束而不是并发执行`)
  }

  await writeFile(file, mine)
  return { preempted: holder }
}

async function releaseLock(root) {
  await rm(joinFor(root).join(root, '.setup.lock'), { force: true })
}

async function withLock(root, body) {
  const { preempted } = await acquireLock(root)
  try {
    return await body(preempted)
  } finally {
    await releaseLock(root)
  }
}

const lockNote = (preempted) =>
  preempted === null
    ? []
    : [`锁：接管了残留锁（原 pid ${preempted?.pid ?? '未知'}，时间 ${new Date(preempted?.time ?? 0).toISOString()}）`]

function planItems(planned) {
  return [
    {
      name: 'engine',
      path: planned.engine.path,
      present: planned.engine.present,
      ...(planned.engine.reason === undefined ? {} : { reason: planned.engine.reason }),
    },
    {
      name: 'amdl',
      path: planned.amdl.path,
      present: planned.amdl.present,
      ...(planned.amdl.reason === undefined ? {} : { reason: planned.amdl.reason }),
    },
  ]
}

async function planAction({ root, platform, d, config }) {
  const planned = await d.plan(root, { platform })
  const runId = config.engineRunId || ENGINE_RUN_ID
  const items = planItems(planned)

  const free = await freeBytes(root)
  const need = ENGINE_UNPACKED_BYTES * 1.5

  const lines = [
    `状态目录：${root}`,
    `引擎：${planned.engine.present ? '已就绪' : '缺失'} → ${planned.engine.path}`,
    planned.engine.reason === undefined ? null : `  ${planned.engine.reason}`,
    `amdl：${planned.amdl.present ? '已就绪' : '缺失'} → ${planned.amdl.path}`,
    planned.amdl.reason === undefined ? null : `  ${planned.amdl.reason}`,
    `目标引擎版本：run_id ${runId}，资产 ${ENGINE_ARTIFACT}，${ENGINE_BYTES.toLocaleString('en-US')} B，`
      + `sha256 ${String(config.engineSha256 || ENGINE_SHA256).replace(/^sha256:/i, '').slice(0, 12)}…`,
    `预计耗时：先下 amdl（约 4 s），再下引擎（约 ${ENGINE_SECONDS} s），最后解压并校验四个关键文件`,
    free === null
      ? '磁盘空间：无法预检（statfs 不可用），fetch-engine 会再查一次'
      : `磁盘空间：${gb(free)} 可用，fetch-engine 要求 ≥ ${gb(need)}（解压后估算 ${gb(ENGINE_UNPACKED_BYTES)} × 1.5）`,
    `产物落位：引擎 ${planned.engine.path}；amdl ${planned.amdl.path}`,
  ].filter((line) => line !== null)

  return {
    action: 'plan',
    ok: items.every((item) => item.present),
    items,
    summary: lines.join('\n'),
  }
}

async function verifyAction({ root, platform, d }) {
  const verified = await d.verify(root, { platform })
  const missing = verified.items.filter((item) => item.problem !== undefined)
  return {
    action: 'verify',
    ok: verified.ok,
    items: verified.items,
    summary: verified.ok
      ? `全部 ${verified.items.length} 项就绪，均在 ${root} 下`
      : `${missing.length} / ${verified.items.length} 项不完整，详见 items 里的 problem`,
  }
}

async function fetchAmdlAction({ root, platform, d }) {
  const { bin } = pathsFor(root)
  const j = joinFor(root).join
  const asset = d.amdlAssetNameFor(platform)
  const dest = j(bin, binNameFor(platform))
  const staged = j(bin, asset)
  const sums = j(bin, 'checksums.txt')
  const assetUrl = `${AMDL_BASE}/${asset}`
  const sumsUrl = `${AMDL_BASE}/checksums.txt`

  await mkdir(bin, { recursive: true })

  return withLock(root, async (preempted) => {
    let expected
    try {
      await d.downloadToFile(sumsUrl, sums)
      expected = expectedShaFor(await readFile(sums, 'utf8'), asset)
    } finally {
      await rm(sums, { force: true })
    }

    await d.downloadToFile(assetUrl, staged)
    const actual = await d.sha256OfFile(staged)

    if (actual !== expected) {
      // 拒绝安装：连下载产物一起删，否则下次重跑会拿坏文件撞同一个错
      await rm(staged, { force: true })
      await rm(`${staged}.partial`, { force: true })
      throw new Error(
        `amdl 的 sha256 与 checksums.txt 不符，拒绝安装：期望 ${expected}，实际 ${actual}（来源 ${assetUrl}）`,
      )
    }

    await rm(dest, { force: true })
    await rename(staged, dest)
    const size = (await stat(dest)).size

    return {
      action: 'fetch-amdl',
      ok: true,
      items: [{ name: binNameFor(platform), path: dest, size }],
      summary: [
        `amdl 已安装：${dest}（${size.toLocaleString('en-US')} B，sha256 ${actual.slice(0, 12)}…）`,
        `来源：${assetUrl}`,
        `校验：checksums.txt 中 ${asset} 的 sha256 一致`,
        ...lockNote(preempted),
      ].join('\n'),
    }
  })
}

async function fetchEngineAction({ root, platform, d, config }) {
  const engineRoot = pathsFor(root).engine
  const zipPath = joinFor(root).join(engineRoot, 'wrapper-lite-qemu.zip')
  const runId = config.engineRunId || ENGINE_RUN_ID
  const want = String(config.engineSha256 || ENGINE_SHA256)
  const url = d.assetUrlFor('win32', runId, ENGINE_ARTIFACT)

  await mkdir(engineRoot, { recursive: true })

  const free = await freeBytes(engineRoot)
  const need = ENGINE_UNPACKED_BYTES * 1.5
  if (free !== null && free < need) {
    throw new Error(
      `磁盘空间不足：${engineRoot} 可用 ${gb(free)}，解压后估算 ${gb(ENGINE_UNPACKED_BYTES)}，`
        + `要求 ≥ ${gb(need)}（× 1.5）。请腾出空间或改 engineDir`,
    )
  }

  return withLock(root, async (preempted) => {
    let reusedZip = false
    if ((await exists(zipPath)) && sha256Match(want, await d.sha256OfFile(zipPath))) {
      reusedZip = true
    } else {
      await d.downloadToFile(url, zipPath)
      const actual = await d.sha256OfFile(zipPath)
      if (!sha256Match(want, actual)) {
        // 拒绝安装：坏 zip 留着会让下次重跑撞同一个错，永远无法自愈
        await rm(zipPath, { force: true })
        await rm(`${zipPath}.partial`, { force: true })
        throw new Error(
          `引擎 zip 的 sha256 不符，拒绝解压：期望 ${want}，实际 ${actual}（来源 ${url}）`,
        )
      }
    }

    try {
      // 参数数组，不拼 shell 字符串：路径含空格/中文时拼串会炸
      await run('tar', ['-xf', zipPath, '-C', engineRoot], { windowsHide: true })
    } catch (err) {
      const detail = String(err?.stderr ?? err?.message ?? err).trim()
      throw new Error(
        `解压失败（tar -xf "${zipPath}" -C "${engineRoot}"）：${detail}。`
          + 'Windows 10/11 自带 tar.exe；若缺失请安装 bsdtar，或手动把该 zip 解压到上述目录',
      )
    }

    const verified = await d.verify(root, { platform })
    // `verify` 恒返回 5 项（引擎 4 文件 + amdl），而本 action 只负责引擎：
    // 只认 `<root>/engine/` 下的项，否则首次只跑 fetch-engine 会因 amdl 未装而误报失败。
    const engineItems = verified.items.filter((item) => isInside(engineRoot, item.path))
    const broken = engineItems.filter((item) => item.problem !== undefined)
    if (engineItems.length === 0 || broken.length > 0) {
      const problems = broken.length > 0
        ? broken.map((i) => i.problem)
        : [`校验未覆盖引擎目录 ${engineRoot}，解压结果无法确认`]
      throw new Error(`解压后校验失败，引擎不完整：\n${problems.join('\n')}`)
    }

    return {
      action: 'fetch-engine',
      ok: true,
      items: engineItems,
      summary: [
        reusedZip
          ? `引擎 zip 已存在且 sha256 相符，跳过下载直接解压：${zipPath}`
          : `引擎已下载并通过校验：${zipPath}（${ENGINE_BYTES.toLocaleString('en-US')} B）`,
        `版本：run_id ${runId}，资产 ${ENGINE_ARTIFACT}`,
        `解压到：${engineRoot}（zip 保留，便于重解压）`,
        `校验：引擎四个关键文件齐全（${engineItems.length} / ${verified.items.length} 项通过；amdl 由 fetch-amdl 负责）`,
        ...lockNote(preempted),
      ].join('\n'),
    }
  })
}

/**
 * 跑一次 `amdl_setup`。
 *
 * @param {{
 *   action: 'plan' | 'fetch-amdl' | 'fetch-engine' | 'verify',
 *   root: string,
 *   platform?: string,
 *   deps?: typeof import('./deps.js'),
 *   config?: Record<string, unknown>,
 * }} options
 *   `deps` 可整体注入（测试用），注入时必须提供该 action 用到的全部函数：
 *   `plan`/`verify` → `plan` / `verify`；`fetch-amdl` → `amdlAssetNameFor` /
 *   `downloadToFile` / `sha256OfFile`；`fetch-engine` → `assetUrlFor` /
 *   `downloadToFile` / `sha256OfFile` / `verify`。落位、解压与磁盘预检不走 `deps`。
 * @returns {Promise<{ action: string, ok: boolean, items: Array<object>, summary: string }>}
 */
export async function runSetup(options) {
  const { action, root, platform = process.platform, deps, config = {} } = options ?? {}

  if (!ACTIONS.includes(action)) {
    throw new Error(`未知 action：${String(action)}（可选 ${ACTIONS.join(' / ')}）`)
  }
  if (typeof root !== 'string' || root === '') {
    throw new Error('runSetup 需要 root（状态根目录绝对路径）')
  }

  const d = { ...realDeps, ...(deps ?? {}) }
  const ctx = { root, platform, d, config }

  if (action === 'plan') return planAction(ctx)
  if (action === 'verify') return verifyAction(ctx)
  if (action === 'fetch-amdl') return fetchAmdlAction(ctx)
  return fetchEngineAction(ctx)
}
