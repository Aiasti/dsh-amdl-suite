/**
 * `amdl_download` 的纯逻辑：两种输入模式 → 起引擎 → 串行逐首下载 → 校验 → 汇总。
 *
 * 本文件属**测试可 import** 的那一层（Ruling 20），只 import `node:*` 与同目录 `lib/`。
 *
 * 几条不能改的行为：
 * - **串行**：一次只跑一个 amdl 进程，它自己在文件内分段并发（design §4.4）。
 * - **不自动删用户文件**：半成品只报告，绝不 `rm`（design §9.2 记着删错整棵树的真实事故）。
 * - **只停自己拉起的引擎**：进来时引擎已在跑就不碰它（design §6.6）。
 */
import { spawn } from 'node:child_process'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConfig, downloadOne } from './amdl.js'
import { ensureEngine, stopEngine } from './engine.js'
import { pathsFor } from './paths.js'
import { splitLines } from './logparse.js'
import { killTree } from './proctree.js'
import { toYaml } from './yaml.js'

const joinFor = (root) => (String(root).includes('\\') ? path.win32 : path.posix)

const VENDOR = fileURLToPath(new URL('../vendor/', import.meta.url))

const PORT = 12340

/**
 * 判定输入模式。两个都给或都不给都算用法错误——不要"猜一个"。
 *
 * @param {{ workDir?: string, urls?: string[] }} args
 * @returns {'playlist' | 'direct'}
 */
export function detectMode(args = {}) {
  const hasWork = typeof args.workDir === 'string' && args.workDir.trim() !== ''
  const hasUrls = Array.isArray(args.urls) && args.urls.length > 0
  if (hasWork && hasUrls) {
    throw new Error('workDir 与 urls 互斥：歌单模式给 workDir，直链模式给 urls，不能同时给')
  }
  if (!hasWork && !hasUrls) {
    throw new Error('必须提供 workDir（歌单模式）或 urls（直链模式）之一')
  }
  return hasWork ? 'playlist' : 'direct'
}

/**
 * 从换籍产物里取可下载 URL。
 *
 * 跳过 `url` 为空（账号区无资产）与 `duplicate`（同一 Apple trackId 的重复项）——
 * 后者若照下，第二次必撞 `Track already exists`，用户会以为出错了。
 *
 * @param {Array<{ idx?: number, url?: string, duplicate?: boolean }>} rows
 * @returns {Array<{ idx: number, url: string }>}
 */
export function urlsFromResolved(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => typeof r?.url === 'string' && r.url !== '' && r.duplicate !== true)
    .map((r) => ({ idx: Number(r.idx), url: r.url }))
    .sort((a, b) => a.idx - b.idx)
}

/**
 * 按判定分桶。
 *
 * `ok`/`aac`/`exists` 都算"不失败"（AAC 是有损降级、exists 是本来就在），
 * `key500` 单列（跨区链接的典型症状），`timeout`/`cancelled` 归 `failed` 但单独计数。
 *
 * @param {Array<{ verdict?: string }>} results
 */
export function summarizeDownloads(results) {
  const s = { ok: 0, aac: 0, key500: 0, exists: 0, failed: 0, timeout: 0, cancelled: 0 }
  for (const r of Array.isArray(results) ? results : []) {
    const v = r?.verdict
    if (v === 'ok') s.ok++
    else if (v === 'aac') s.aac++
    else if (v === 'exists') s.exists++
    else if (v === 'key500') s.key500++
    else {
      s.failed++
      if (v === 'timeout') s.timeout++
      if (v === 'cancelled') s.cancelled++
    }
  }
  s.hint = s.key500 > 0
    ? `${s.key500} 首的 id 不在你的账号区目录里（key code=500）。请提供账号区（当前 storefront）的链接，`
      + '或先用 amdl_match 做一次换籍。'
    : ''
  return s
}

/**
 * 找出可疑的半成品。
 *
 * 只报告，**绝不删除**：amdl 中断会留下有 `cover.jpg`、无 `.m4a` 的空壳目录；
 * 而半成品 m4a 可能让下次重跑报 `Track already exists`，使该首永久下不动。
 * 让用户自己决定是否清掉（design §9.2 记录过按目录递归删导致整棵树被删的事故）。
 *
 * @param {Array<{ dir: string, m4a?: number, cover?: boolean }>} entries
 */
export function findSuspicious(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => !(Number(e?.m4a) > 0))
    .map((e) => ({
      dir: e.dir,
      reason: e?.cover === true
        ? '只有封面、没有 .m4a（中断留下的空壳）'
        : '没有任何 .m4a',
    }))
}

/**
 * 扫输出目录，给每个子目录（以及根目录本身）统计 m4a 大小与有没有封面。
 *
 * @param {string} dir
 */
export async function collectEntries(dir) {
  const j = joinFor(dir).join
  const entries = []
  const inspect = async (target) => {
    let names
    try {
      names = await readdir(target, { withFileTypes: true })
    } catch {
      return
    }
    let m4a = 0
    let sawM4a = false
    let cover = false
    for (const dirent of names) {
      if (dirent.isDirectory()) continue
      if (/\.m4a$/i.test(dirent.name)) {
        sawM4a = true
        try {
          m4a += (await stat(j(target, dirent.name))).size
        } catch { /* 忽略单文件失败 */ }
      }
      if (/^cover\.(jpe?g|png)$/i.test(dirent.name)) cover = true
    }
    // 只收「看起来是个曲目目录」的：见到 m4a 文件，或见到封面。
    // 两者都没有的目录（含输出根目录）是纯容器或空目录，报出来只会淹没真正的可疑项。
    if (sawM4a || cover) entries.push({ dir: target, m4a, cover })
    for (const dirent of names) {
      if (dirent.isDirectory()) await inspect(j(target, dirent.name))
    }
  }
  await inspect(dir)
  return entries
}

/**
 * 把 `verify-alac.js` 的结果压成一行给模型看（design §6.5 step 7 要求汇总里报音质）。
 *
 * 脚本两种输出形态：≤5 个文件时每行一个 JSON（有 `codec`/`bitDepth`/`sampleRate`），
 * `>5` 时是汇总文本。两种都要能报，否则"下载成功"与"真的是无损"之间没有桥。
 *
 * @param {{ files?: object[], text?: string, error?: string }} [quality]
 * @returns {string} 空字符串表示无可报内容
 */
export function formatQuality(quality) {
  const q = quality ?? {}
  if (typeof q.error === 'string' && q.error !== '') return `音质复核失败：${q.error}`

  const files = Array.isArray(q.files) ? q.files : []
  if (files.length > 0) {
    const bad = files.filter((f) => String(f?.codec ?? '').toLowerCase() !== 'alac')
    if (bad.length > 0) {
      const names = bad.slice(0, 5).map((f) => String(f?.file ?? '?')).join('、')
      return `音质复核：${files.length} 个文件，其中 ${bad.length} 个不是 ALAC（${names}）`
    }
    // 单曲时把位深/采样率直接报出来，多曲只报数量
    if (files.length === 1) {
      const f = files[0]
      return `音质复核：${String(f?.file ?? '')} → ${f?.codec} ${f?.bitDepth} bit / ${f?.sampleRate} Hz，${f?.tier ?? ''}`.trim()
    }
    return `音质复核：${files.length} 个文件全部为 ALAC`
  }

  const text = typeof q.text === 'string' ? q.text.trim() : ''
  if (text === '') return ''
  return `音质复核：${text.split('\n').slice(-3).join(' / ')}`
}

/**
 * 跑 `verify-alac.js` 复核音质。
 *
 * 脚本输出两种形态：≤5 个文件时每行一个 JSON（含 `codec`），>5 个时是汇总文本。
 * 两种都要能处理，所以按行尝试 `JSON.parse`，失败的行原样留在 `text` 里。
 *
 * @returns {Promise<{ files: object[], text: string } | { error: string }>}
 */
function verifyAlac(dir, { spawnImpl, root }) {
  const j = joinFor(root).join
  return new Promise((resolve) => {
    const proc = spawnImpl(process.execPath, [j(VENDOR, 'verify-alac.js'), dir], { windowsHide: true })
    let raw = ''
    let pending = ''
    proc.stdout?.setEncoding?.('utf8')
    proc.stderr?.setEncoding?.('utf8')
    proc.stdout?.on?.('data', (chunk) => {
      const s = splitLines(pending + String(chunk))
      pending = s.rest
      raw += String(chunk)
    })
    proc.stderr?.on?.('data', (chunk) => { raw += String(chunk) })
    proc.on?.('error', (err) => resolve({ error: String(err?.message ?? err) }))
    proc.on?.('close', () => {
      if (pending !== '') raw += pending
      const files = []
      const text = []
      for (const line of raw.split('\n')) {
        const t = line.trim()
        if (t === '') continue
        try {
          files.push(JSON.parse(t))
        } catch {
          text.push(t)
        }
      }
      resolve({ files, text: text.join('\n') })
    })
  })
}

/**
 * 监视「多久没有新输出」。
 *
 * design §6.9：插件**不据此自主退出**（那是用户否决过的硬超时）。它只往 job ring
 * 里丢一行提示，停不停由 Agent 读 `job_output` 后判断、或用户 `job_kill`。
 *
 * @param {{ seconds: number, append: (text: string) => void, now: () => number, timers: object }} options
 */
function startStallWatch({ seconds, append, now, timers }) {
  const limit = Number(seconds) * 1000
  if (!(limit > 0)) return { touch() {}, stop() {} }

  let last = now()
  let warnedFor = -1
  const timer = timers.setInterval(() => {
    const idle = now() - last
    // 同一个 idle 区间只提示一次，避免长时间卡住时刷屏
    if (idle < limit || warnedFor === last) return
    warnedFor = last
    append(`已 ${Math.round(idle / 1000)} 秒无新输出，可能停滞（未中断；可 job_output 观察或 job_kill）`)
  }, Math.max(250, Math.min(limit / 2, 5000)))
  timer?.unref?.()

  return {
    touch: () => { last = now() },
    stop: () => timers.clearInterval(timer),
  }
}

/**
 * 跑完一次下载（两种模式共用）。
 *
 * @param {{
 *   urls: Array<{ idx?: number, url: string }>,
 *   root: string,
 *   config?: Record<string, unknown>,
 *   mode?: 'playlist' | 'direct',
 *   append?: (text: string) => void,
 *   isCancelled?: () => boolean,
 *   registerCancel?: (fn: () => void) => void,
 *   deps?: Record<string, Function>,
 * }} options
 */
export async function runDownloads(options) {
  const {
    urls,
    root,
    config = {},
    mode = 'direct',
    append = () => {},
    isCancelled = () => false,
    registerCancel = () => {},
    deps = {},
  } = options

  const spawnImpl = deps.spawn ?? spawn
  const j = joinFor(root).join
  const paths = pathsFor(root)
  const outputDir = String(config.outputDir ?? '') !== '' ? String(config.outputDir) : paths.output
  const engineDir = String(config.engineDir ?? '') !== ''
    ? String(config.engineDir)
    : j(paths.engine, 'wrapper-lite-qemu')
  const amdlPath = String(config.amdlPath ?? '') !== ''
    ? String(config.amdlPath)
    : j(paths.bin, process.platform === 'win32' ? 'amdl.exe' : 'amdl')

  const ensure = deps.ensureEngine ?? ensureEngine
  const stop = deps.stopEngine ?? stopEngine
  const one = deps.downloadOne ?? downloadOne
  const kill = deps.killTree ?? killTree
  const verify = deps.verifyAlac ?? ((dir) => verifyAlac(dir, { spawnImpl, root }))

  const base = { mode, outputDir, engineDir, amdlPath, urls: urls.length }
  const results = []
  let suspicious = []
  let quality = { error: '未执行到音质复核' }

  // 1. 起引擎（已在线则复用，不碰别人的进程）
  append(`起引擎：${engineDir}`)
  const engine = await ensure({ engineDir, port: PORT, platform: process.platform })

  if (Array.isArray(engine?.regions) && engine.regions.length === 0) {
    append('登录态失效：引擎 /status 的 regions 为空，请按上游文档在 QEMU 串口重新登录（不要删 data.img）')
    if (engine.reused === false && engine.pid !== null) await stop(engine.pid)
    return {
      ...base,
      ...summarizeDownloads([]),
      results: [],
      suspicious: [],
      verify: { error: '引擎登录态失效（regions 为空）' },
      engine: { reused: engine.reused === true, regions: [] },
      loginRequired: true,
    }
  }
  const selfStarted = engine?.reused === false && engine?.pid !== null && engine?.pid !== undefined
  if (engine?.reused === true) append('复用了已在运行的引擎（结束时不会停它）')
  // 只停自己拉起的那个；cancel 路径也要停，否则会话关了引擎会残留
  if (selfStarted) registerCancel(() => { stop(engine.pid).catch(() => {}) })

  try {
    // 2. 生成 config.yaml —— 落到插件自己的 config 目录，不碰用户现有的
    const cfgPath = j(paths.config, 'amdl.yaml')
    await mkdir(paths.config, { recursive: true })
    const storefront = String(config.storefront ?? (engine?.regions?.[0] ?? 'us'))
    await writeFile(cfgPath, toYaml(buildConfig({
      liteServer: `http://127.0.0.1:${PORT}`,
      storefront,
      alacDir: outputDir,
      alacMax: Number(config.alacMax ?? 192000),
    })), 'utf8')
    await mkdir(outputDir, { recursive: true })
    append(`配置：${cfgPath}（storefront=${storefront}）；产物落位：${outputDir}`)

    // 3. 逐首串行。**不传 `timeoutMs`**：design §6.9 明确不设硬超时（用户已否决），
    // 卡住与否由「疑似停滞」提示交给 Agent 判断；取消走 `signal`。
    const controller = new AbortController()
    registerCancel(() => controller.abort())
    const stall = startStallWatch({
      seconds: Number(config.stagnationSeconds ?? 60),
      append,
      now: deps.now ?? Date.now,
      timers: deps.timers ?? { setInterval, clearInterval },
    })
    try {
      for (const [i, item] of urls.entries()) {
        if (isCancelled()) {
          append(`已取消：完成 ${i} / ${urls.length}`)
          break
        }
        const label = item.idx === undefined ? item.url : `#${item.idx} ${item.url}`
        append(`[${i + 1}/${urls.length}] ${label}`)
        stall.touch()
        const r = await one({
          amdlPath,
          configPath: cfgPath,
          url: item.url,
          signal: controller.signal,
          killTree: kill,
          onLine: (line) => {
            if (String(line).trim() === '') return
            stall.touch()
            append(String(line))
          },
        })
        results.push({ ...r, idx: item.idx })
        if (r.verdict !== 'ok' && r.verdict !== 'aac' && r.verdict !== 'exists') {
          append(`[${i + 1}/${urls.length}] 判定 ${r.verdict}${r.path ? ` → ${r.path}` : ''}`)
        }
      }
    } finally {
      stall.stop()
    }

    // 4. 收尾：只报告可疑项，绝不删除。已取消时不再起新子进程去复核 ——
    //    job 已经 killed，再 spawn 一个 verify 只会拖慢收尾并扫全量输出目录。
    if (isCancelled()) {
      append('已取消：跳过可疑项扫描与音质复核')
    } else {
      const entries = await collectEntries(outputDir)
      suspicious = findSuspicious(entries)
      quality = await verify(outputDir)

      if (suspicious.length > 0) {
        append(`可疑项 ${suspicious.length} 个（未删除，请自行确认）：`)
        for (const s of suspicious) append(`  ${s.dir} —— ${s.reason}`)
      }
    }
  } finally {
    // 5. 停引擎：无论上面成功还是抛错，自己拉起的都要停掉
    if (selfStarted) {
      await stop(engine.pid).catch(() => {})
      append('已停掉本工具拉起的引擎')
    }
  }

  return {
    ...base,
    ...summarizeDownloads(results),
    results,
    suspicious,
    verify: quality,
    engine: { reused: engine?.reused === true, regions: engine?.regions ?? [] },
  }
}