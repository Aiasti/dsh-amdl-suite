/**
 * `amdl_match` 的纯逻辑：歌单链接 → 取数 → 跨区匹配 → 换籍。
 *
 * 本文件属**测试可 import** 的那一层（Ruling 20），所以只 import `node:*` 与同目录
 * `lib/`，**不得** import `@deepseek-ai/*` 或 `../tools/*`——纯 Node 下解析不到。
 *
 * 四个 vendor 脚本的 CLI 与产物名是硬契约（见 design §6.4.1）。名字传错，Task 12
 * 就读不到 `pl-download-cn.json`，所以 `runMatch` 的 fork 参数被测试逐字钉住。
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { statusOf } from './engine.js'
import { splitLines } from './logparse.js'
import { pathsFor, workDirFor } from './paths.js'
import { killTree } from './proctree.js'

const joinFor = (root) => (String(root).includes('\\') ? path.win32 : path.posix)

const VENDOR = fileURLToPath(new URL('../vendor/', import.meta.url))

/** 词表源目录（随插件分发）。运行期要复制到 `<root>/data`，见 `ensureWordLists`。 */
const WORD_LISTS = ['TSCharacters.txt', 'TSPhrases.txt']

const DOWNLOAD_TIERS = new Set(['A-name', 'B-duration+album'])
const REVIEW_TIERS = new Set(['C-duration-only', 'C-album-only', 'C-artist-duration'])

/**
 * 从歌单链接或纯 id 里解出歌单 id。
 *
 * 三种常见形态都要认：
 *   - `https://music.163.com/#/playlist?id=17797589229`（**id 在 hash 里**，`URL.searchParams` 取不到）
 *   - `https://y.music.163.com/m/playlist?id=123&userid=9`（`&userid=` 里的 `id=` 不能误匹配）
 *   - 纯数字 `17797589229`
 *
 * @param {string} input
 * @returns {string}
 */
export function playlistIdOf(input) {
  const s = String(input ?? '').trim()
  if (s === '') throw new Error('需要网易云歌单链接或歌单 id')
  if (/^\d+$/.test(s)) return s
  // 要求 id= 前面是 ? 或 &：`&userid=9` 里 `id=` 之前是 `r`，不会被误匹配
  const m = /[?&]id=(\d+)/.exec(s)
  if (m) return m[1]
  throw new Error(`无法从 ${s} 解析出歌单 id（期望形如 .../playlist?id=123 或纯数字）`)
}

/**
 * 解析 JWT 的过期时间（秒）。拿不到就返回 `null`。
 *
 * @param {string} token
 * @returns {number | null}
 */
export function tokenExpiry(token) {
  try {
    const seg = String(token ?? '').split('.')[1]
    if (seg === undefined || seg === '') return null
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'))
    return typeof payload?.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

/**
 * 是否该重取 token：文件缺失、解析不出 `exp`、或 24 小时内过期都算。
 *
 * @param {string | null} token
 * @param {number} [nowMs]
 * @param {number} [marginMs]
 * @returns {boolean}
 */
export function tokenNeedsRefresh(token, nowMs = Date.now(), marginMs = 24 * 60 * 60 * 1000) {
  if (typeof token !== 'string' || token.trim() === '') return true
  const exp = tokenExpiry(token)
  if (exp === null) return true
  return exp * 1000 < nowMs + marginMs
}

/**
 * 按四档 + 重试统计报告，并单列换籍后的真实可下载数。
 *
 * 四档之和恒等于 `report.length`：未知 verdict 归入 `notFound` 并在 `unknown` 里计数，
 * 避免"某档漏算"变成静默缺口。
 *
 * **不要拿 `download`（A/B 命中数）当"能下几首"**：换籍后才知道账号区到底有没有资产
 * （design §6.4.1 要求分「可下 X / 重复 Z / 国区无资产 Y / 共 N」四项，且不许混算）。
 * 真实例子：A-name 命中 2 首，国区只有 1 首有资产 —— 报「可下载 2」就是系统性高估。
 *
 * @param {Array<{ verdict?: string }>} report 匹配报告（每首一行的判定）
 * @param {Array<{ url?: string, duplicate?: boolean }>} [resolved] 换籍产物 `pl-download-cn.json`
 */
export function summarize(report, resolved = []) {
  const s = { download: 0, review: 0, notFound: 0, retry: 0, unknown: 0, accountMissing: 0 }
  for (const r of Array.isArray(report) ? report : []) {
    const v = r?.verdict
    if (DOWNLOAD_TIERS.has(v)) s.download++
    else if (REVIEW_TIERS.has(v)) s.review++
    else if (v === 'retry') s.retry++
    else if (v === 'D-no') s.notFound++
    else { s.notFound++; s.unknown++ }
  }

  const rows = Array.isArray(resolved) ? resolved : []
  s.duplicate = rows.filter((r) => r?.duplicate === true).length
  s.accountMissing = rows.filter((r) => r?.duplicate !== true && (r?.url ?? '') === '').length
  s.downloadable = rows.filter((r) => r?.duplicate !== true && (r?.url ?? '') !== '').length
  return s
}

/**
 * match job 的最终 result 文案（模型能可靠拿到的只有 result，不能只写进 ring）。
 *
 * 必须自包含：总数、换籍后的三项、四类档位、匹配报告路径、账号区复核结论。
 *
 * @param {ReturnType<typeof summarize> & { matchReportPath?: string, review?: object }} r
 * @returns {string}
 */
export function formatMatchSummary(r) {
  const total = Number(r?.download ?? 0) + Number(r?.review ?? 0)
    + Number(r?.notFound ?? 0) + Number(r?.retry ?? 0)
  const lines = [
    `共 ${total} 首：可下 ${r?.downloadable ?? 0} / 重复 ${r?.duplicate ?? 0} / 国区无资产 ${r?.accountMissing ?? 0}`,
    `匹配档位：A+B ${r?.download ?? 0} / 需复核 ${r?.review ?? 0} / 未找到 ${r?.notFound ?? 0} / 请求失败 ${r?.retry ?? 0}`,
  ]
  if (typeof r?.matchReportPath === 'string' && r.matchReportPath !== '') {
    lines.push(`匹配报告：${r.matchReportPath}`)
  }
  const v = r?.accountReview
  if (v && v.skipped === true) lines.push(`账号区复核：未做（${v.reason ?? '原因未知'}）`)
  else if (v) lines.push(`账号区复核：C/D 档 ${v.total} 首中 ${v.found} 首在账号区找到疑似同一首（${v.mdPath}，未自动下载）`)
  return lines.join('\n')
}

/**
 * 账号区解析：Config → 运行中的 `/status` → `state/account.json` → 未知。
 *
 * 不为此启动引擎；解析不到就跳过复核，由调用方在 result 里说明原因。
 *
 * @param {{ root: string, config?: Record<string, unknown>, statusOfImpl?: Function }} options
 * @returns {Promise<{ storefront: string, source: 'config'|'status'|'state'|'unknown' }>}
 */
export async function accountFor({ root, config = {}, statusOfImpl = statusOf }) {
  const explicit = String(config.accountStorefront ?? '').trim()
  if (explicit !== '') return { storefront: explicit, source: 'config' }

  if (typeof statusOfImpl === 'function') {
    try {
      const s = await statusOfImpl(12340)
      const first = Array.isArray(s?.regions) ? s.regions[0] : undefined
      if (s?.code === 0 && typeof first === 'string' && first !== '') {
        return { storefront: first, source: 'status' }
      }
    } catch { /* 引擎没起，继续看状态文件 */ }
  }

  try {
    const file = joinFor(root).join(root, 'state', 'account.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    if (typeof saved?.storefront === 'string' && saved.storefront !== '') {
      return { storefront: saved.storefront, source: 'state' }
    }
  } catch { /* 没有状态文件 */ }

  return { storefront: '', source: 'unknown' }
}

/**
 * 把随插件分发的两份 OpenCC 词表复制到 `<root>/data`。
 *
 * **必须有这一步**：`score.js` 的 `DATA_DIR` 默认是 `plugin/data`（不存在），
 * 而 `runMatch` 又会把 `NEAM_DATA` 指到 `<root>/data`。漏复制的话 `foldChars`
 * 会静默 catch 退化成恒等，繁简匹配（牛尾憲輔 ↔ 牛尾宪辅）悄悄失效、不报错。
 *
 * 已存在且大小相同则跳过，避免每次匹配重复写盘。
 */
export async function ensureWordLists(root) {
  const { data } = pathsFor(root)
  const j = joinFor(root).join
  await mkdir(data, { recursive: true })
  for (const name of WORD_LISTS) {
    const dest = j(data, name)
    const src = j(VENDOR, 'data', name)
    const srcSize = (await stat(src)).size
    let destSize = null
    try {
      destSize = (await stat(dest)).size
    } catch { /* 不存在，走复制 */ }
    if (destSize === srcSize) continue
    await copyFile(src, dest)
  }
  return data
}

/**
 * 跑一条 vendor 脚本，逐行把输出交给 `onLine`（job ring 靠这个显示进度）。
 *
 * 用 `spawn` 而不是 `execFile`：`match.js` 对每首曲目都要打印进度，攒到进程结束
 * 再一次性吐出，Agent 就没法从 `job_output` 判断"是在跑还是卡住了"（design §6.7）。
 * 顺带也躲开了 `execFile` 默认 1 MB 的 `maxBuffer` 上限。
 *
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runScript(script, args, { env, root, spawnImpl, onLine, onChild }) {
  const j = joinFor(root).join
  return new Promise((resolve, reject) => {
    const proc = spawnImpl(process.execPath, [j(VENDOR, script), ...args], {
      env,
      windowsHide: true,
    })
    onChild?.(proc)
    let stdout = ''
    let stderr = ''

    /** 逐行喂给 sink（供 job ring），同时把原文累积到 stdout/stderr 供报错用。 */
    const pump = (stream, sink, collect) => {
      if (stream === undefined || stream === null) return () => {}
      let rest = ''
      stream.setEncoding?.('utf8')
      stream.on('data', (chunk) => {
        const text = String(chunk)
        collect(text)
        const split = splitLines(rest + text)
        rest = split.rest
        for (const line of split.lines) sink(line)
      })
      // 末尾没换行的半行也要送出去，否则最后一行进度会丢
      return () => {
        if (rest === '') return
        const last = rest
        rest = ''
        sink(last)
      }
    }

    const flushOut = pump(proc.stdout, (line) => onLine?.(line, 'stdout'), (text) => { stdout += text })
    const flushErr = pump(proc.stderr, (line) => onLine?.(line, 'stderr'), (text) => { stderr += text })

    proc.on?.('error', reject)
    proc.on?.('close', (code) => {
      onChild?.(null)
      flushOut()
      flushErr()
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * 跑完整匹配流程。
 *
 * @param {{
 *   playlistUrl: string,
 *   root: string,
 *   config?: Record<string, unknown>,
 *   append?: (text: string) => void,
 *   isCancelled?: () => boolean,
 *   deps?: { spawn?: Function, now?: () => number },
 * }} options
 * @returns {Promise<ReturnType<typeof summarize> & { workDir: string, reportPath: string, cancelled?: boolean }>}
 */
export async function runMatch(options) {
  const {
    playlistUrl, root, config = {}, append = () => {},
    isCancelled = () => false, registerCancel = () => {}, deps = {},
  } = options
  const spawnImpl = deps.spawn ?? spawn
  const now = deps.now ?? Date.now
  const kill = deps.killTree ?? killTree

  // 取消要能打断正在跑的 vendor 脚本：`--min-interval 900` 让大歌单要跑很久，
  // 只"步骤之间检查"等于 job 显示 killed 而脚本仍在写同一目录（design §6.7）。
  let current = null
  registerCancel(() => {
    const proc = current
    const pid = proc?.pid
    if (!Number.isInteger(pid)) return
    kill(pid)
    // taskkill 失败（权限、进程已退出）时兜底直接杀子进程，保证 'close' 一定会来；
    // 否则 Promise 会一直挂在那个子进程上。
    try { proc.kill?.() } catch { /* 已退出 */ }
  })
  const onChild = (proc) => { current = proc }

  const id = playlistIdOf(playlistUrl)
  const j = joinFor(root).join
  const work = workDirFor(root, id)
  const data = await ensureWordLists(root)
  await mkdir(work, { recursive: true })

  const env = { ...process.env, NEAM_DATA: data }
  const onLine = (line, stream) => append(stream === 'stderr' ? `[stderr] ${line}` : line)
  const cancelled = () => ({ ...summarize([], []), workDir: work, reportPath: j(work, 'pl-download-cn.json'), cancelled: true })

  append(`歌单 ${id} → ${work}`)

  // 1. 取歌单
  if (isCancelled()) return cancelled()
  const fetched = await runScript('fetch-netease-playlist.js', [playlistUrl, j(work, 'pl.json')], {
    env, root, spawnImpl, onLine, onChild,
  })
  // 被杀掉的子进程退出码非 0；取消不该被报成"取歌单失败"
  if (isCancelled()) return cancelled()
  if (fetched.code !== 0) throw new Error(`取歌单失败（退出码 ${fetched.code}）：${tail(fetched.stderr)}`)

  // 2. Apple 目录 token（缺失/24h 内过期才重取）
  if (isCancelled()) return cancelled()
  let token = null
  try {
    token = (await readFile(j(data, 'am-token.txt'), 'utf8')).trim()
  } catch { /* 没有就重取 */ }
  if (tokenNeedsRefresh(token, now())) {
    append('取 Apple 目录 token…')
    const tok = await runScript('get-am-token.js', ['--storefronts', String(config.storefronts ?? 'jp,cn,hk')], {
      env, root, spawnImpl, onLine, onChild,
    })
    if (isCancelled()) return cancelled()
    if (tok.code !== 0) {
      throw new Error(
        `取 Apple token 失败（退出码 ${tok.code}）：${tail(tok.stderr)}。`
          + '若持续失败，可能是 music.apple.com 页面结构变了，需更新 get-am-token.js',
      )
    }
  }

  // 3. 跨区匹配。必须显式 --out：默认前缀是 `<歌单文件>-match`，与契约不符
  if (isCancelled()) return cancelled()
  const matched = await runScript('match.js', [
    j(work, 'pl.json'),
    '--out', j(work, 'pl-match'),
    '--storefronts', String(config.storefronts ?? 'jp,cn,hk'),
    '--min-interval', '900',
    '--concurrency', '2',
  ], { env, root, spawnImpl, onLine, onChild })
  if (isCancelled()) return cancelled()
  if (matched.code !== 0) throw new Error(`匹配失败（退出码 ${matched.code}）：${tail(matched.stderr)}`)

  // 4. 换籍。`--out` 决定产物名：<work>/pl-download-cn.json —— Task 12 按这个名字读
  const reportIn = j(work, 'pl-match-report.json')
  const resolvedOut = j(work, 'pl-download-cn.json')
  const report = await readJsonArray(reportIn, '匹配报告')
  const account = deps.account ?? await accountFor({ root, config, statusOfImpl: deps.statusOf })
  append(`账号区：${account.storefront || '未知'}（来源 ${account.source}）`)
  const storefrontArgs = account.storefront === '' ? [] : ['--storefront', account.storefront]

  let resolved = []
  const hasHits = report.some((r) => DOWNLOAD_TIERS.has(r?.verdict))
  if (!hasHits) {
    // 一个 A/B 都没有时不跑换籍：resolve-downloadable 会打印"没有可下载的命中"并 exit 2，
    // 那样四档统计全丢、契约文件也不生成，模型分不清"只是没匹配到"还是"脚本坏了"。
    // 空清单是正常结果，写一份空 JSON 让 Task 12 拿到确定的"没有可下的"。
    await writeFile(resolvedOut, '[]\n', 'utf8')
    append('没有可下载的命中（A/B 档为 0），已写出空的 pl-download-cn.json')
  } else {
    if (isCancelled()) return cancelled()
    const resolvedStep = await runScript('resolve-downloadable.js', [reportIn, '--out', j(work, 'pl'), ...storefrontArgs], {
      env, root, spawnImpl, onLine, onChild,
    })
    if (isCancelled()) return cancelled()
    if (resolvedStep.code !== 0) {
      throw new Error(`换籍失败（退出码 ${resolvedStep.code}）：${tail(resolvedStep.stderr)}`)
    }
    resolved = await readJsonArray(resolvedOut, '换籍产物')
  }

  // 5. 账号区复核：C/D 档不等于「账号区没有」，但只复核、不进下载清单。
  // 没有候选的 D 档也写一行（probe 内部标「没有候选，未探测」），汇总口径才是全部 C/D。
  const reviewTargets = report.filter((r) => REVIEW_TIERS.has(r?.verdict) || r?.verdict === 'D-no')
  let review
  if (account.storefront === '') {
    review = { skipped: true, reason: '账号区未知' }
  } else if (reviewTargets.length === 0) {
    review = { skipped: true, reason: '没有 C/D 候选' }
  } else {
    if (isCancelled()) return cancelled()
    const base = j(work, 'pl-review-account')
    const probed = await runScript('probe-account.js', [
      reportIn, '--storefront', account.storefront, '--out', base, '--min-interval', '900',
    ], { env, root, spawnImpl, onLine, onChild })
    if (isCancelled()) return cancelled()
    if (probed.code !== 0) {
      append(`账号区复核失败（退出码 ${probed.code}）：${tail(probed.stderr)}`)
      review = { skipped: true, reason: '复核脚本失败' }
    } else {
      const rows = await readJsonArray(`${base}.json`, '账号区复核')
      review = {
        total: rows.length,
        found: rows.filter((r) => r?.apple).length,
        jsonPath: `${base}.json`,
        mdPath: `${base}.md`,
      }
      append(`账号区复核：C/D 档 ${review.total} 首中 ${review.found} 首在账号区找到疑似同一首`)
    }
  }

  return {
    ...summarize(report, resolved),
    workDir: work,
    reportPath: resolvedOut,
    matchReportPath: j(work, 'pl-match-report.md'),
    account,
    accountReview: review,
  }
}

/**
 * 读一个"必须是数组"的 JSON 产物。
 *
 * 裸 `JSON.parse(readFile())` 出错时只会得到 `ENOENT` 或 `Unexpected token`，
 * 模型看不出是哪个阶段、哪个文件、下一步该做什么。
 *
 * @param {string} file
 * @param {string} label 给人看的阶段名（如"匹配报告"）
 */
async function readJsonArray(file, label) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    throw new Error(`读不到${label} ${file}：${err?.message ?? err}。`
      + '上游脚本可能中途失败；看 job 输出里该脚本的 stderr。')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`${label} ${file} 不是合法 JSON：${err?.message ?? err}。`
      + '多半是上游脚本写了一半就退出，可重跑本书单。')
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} ${file} 的形状不对：期望数组，实得 ${parsed === null ? 'null' : typeof parsed}。`)
  }
  return parsed
}

const tail = (text) => {
  const lines = String(text ?? '').trim().split('\n').filter(Boolean)
  return lines.slice(-5).join(' / ') || '(无输出)'
}

/**
 * 把 job 的上下文接到 `runMatch` 上，返回 `jobs.start({ run }).run` 里那个 `work`。
 *
 * 放在 lib 而不是 tools 里，是因为 `tools/*.js` 依赖宿主包、纯 Node 下 import 不到，
 * 接线（尤其是 `registerCancel` 必须透传）就无法被测试真实覆盖 —— 上一轮正是漏传它，
 * lib 层修好了而生产路径仍然不杀进程。
 *
 * @param {{ playlistUrl: string, root: string, config?: Record<string, unknown> }} options
 */
export function matchWork({ playlistUrl, root, config = {}, deps = {} }) {
  return async (ctx = {}) => {
    const {
      append = () => {}, isCancelled = () => false, registerCancel = () => {},
    } = ctx
    try {
      const r = await runMatch({ playlistUrl, root, config, append, isCancelled, registerCancel, deps })
      // 取消可能落在收尾窗口里（例如刚读完报告、正要按成功返回）。job 的状态已经是
      // killed，文案就必须跟着说是"已取消"，否则模型会照着成功文案继续下一步。
      if (r.cancelled === true || isCancelled()) {
        append('已取消：未跑完的步骤没有产物')
        return '已取消'
      }
      const summary = formatMatchSummary(r)
      append(summary)
      append(`产物：${r.reportPath}`)
      return summary
    } catch (err) {
      append(`匹配失败：${err?.message ?? err}`)
      throw err
    }
  }
}
