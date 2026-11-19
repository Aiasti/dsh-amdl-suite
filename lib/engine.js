import http from 'node:http'
import path from 'node:path'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'

const DEFAULT_WAIT_MS = 180000
const DEFAULT_POLL_MS = 2000
const STATUS_TIMEOUT_MS = 2000
/** 锁超过这个时长视为崩溃遗留（design §6.8 与 setup 锁同口径）。 */
const LOCK_TTL_MS = 30 * 60 * 1000

/** 第一版只实现 Windows；差异收在这张表里，其余平台明确拒绝而不是猜参数。 */
const LAUNCHERS = { win32: 'wrapper-lite-qemu.exe' }

const joinFor = (root) => (String(root).includes('\\') ? path.win32 : path.posix)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** pid 还在不在。EPERM 说明进程存在但不是我们的。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * 读锁文件。
 *
 * 三种结果必须分开，否则会把别人刚建好的锁搬走（双持）：
 * - `{ missing: true }` —— 文件不在，说明刚被释放：重新抢，**绝不 rename/删**
 * - `null` —— 存在但损坏，按遗留锁处理
 * - 对象 —— 正常内容
 */
async function readLock(lockPath) {
  let text
  try {
    text = await readFile(lockPath, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return { missing: true }
    return null
  }
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 抢引擎启动锁（design §6.8：粒度是引擎端口，`<状态目录>/.engine.lock`）。
 *
 * 抢不到**不是错误** —— 说明另一个会话正在拉起引擎，我们等它就绪后复用即可。
 * 只有"崩溃遗留锁"（持有者 pid 已消失，或超过 30 分钟）才抢占：
 * 用 `rename` 原子搬走再 `wx`，不会把别人刚建好的锁删掉。
 *
 * @returns {Promise<{ acquired: boolean, holder?: object, release?: () => Promise<void> }>}
 */
export async function acquireEngineLock(lockPath, options = {}) {
  const now = options.now ?? Date.now
  await mkdir(path.dirname(lockPath), { recursive: true })

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: now() }), { flag: 'wx' })
      return {
        acquired: true,
        release: async () => {
          // 只删自己的锁：pid 对不上就说明已被别人接管/重建
          const cur = await readLock(lockPath)
          if (cur !== null && cur.missing !== true && cur.pid !== process.pid) return
          await rm(lockPath, { force: true })
        },
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err

      const holder = await readLock(lockPath)
      // 刚被别人释放：直接回到循环重新 `wx`，不要 rename（那会搬走第三者刚建的新锁）
      if (holder !== null && holder.missing === true) continue
      const stale = holder === null
        || !pidAlive(holder.pid)
        || now() - Number(holder.at ?? 0) > LOCK_TTL_MS
      if (!stale) return { acquired: false, holder }

      const grave = `${lockPath}.stale-${process.pid}`
      try {
        await rename(lockPath, grave)
      } catch (e) {
        // 别人抢先搬走了：回到循环重新抢，绝不盲删
        if (e?.code === 'ENOENT') continue
        throw e
      }
      await rm(grave, { force: true }).catch(() => {})
    }
  }

  return { acquired: false, holder: await readLock(lockPath) }
}

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
 * `engineDir` 是**引擎产物目录本身**（直接含 `wrapper-lite-qemu.exe` 与 `qemu/` 的那一层），
 * 不是引擎根。完整示例：`C:\Users\me\.dsh\state\engine\wrapper-lite-qemu`，
 * 启动器即其下的 `wrapper-lite-qemu.exe`。`deps.js` 的 `plan()` 返回的 `engine.path`
 * 的 `dirname` 正是这一层，Task 10/12 原样透传即可。传引擎根仅为兼容兜底。
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

  const jl = joinFor(engineDir).join
  // 锁放状态根目录：engineDir 是 <root>/engine/wrapper-lite-qemu，往上两层即 <root>
  const lockPath = options.lockPath ?? jl(jl(engineDir, '..', '..'), '.engine.lock')
  // 锁拿不到不该挡住启动（例如自定义 engineDir 推到了盘根、或目录只读）：
  // 退化成"无锁单跑"，并用 summary 之外的方式暴露在错误文案里。
  let lock = { acquired: true, release: async () => {} }
  try {
    lock = await acquireEngineLock(lockPath)
  } catch { /* 降级：本次不持锁 */ }

  if (!lock.acquired) {
    // 别的会话正在拉起引擎：等它起来后复用，**绝不重复 spawn**（两个进程会抢 12340，
    // 而且先完成的会话会把另一个正在用的引擎停掉）。
    const holder = lock.holder ?? await readLock(lockPath)
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
      const status = await statusOf(port, { fetchImpl })
      if (status !== null && status.code === 0) {
        return { pid: null, regions: status.regions, reused: true }
      }
    }
    throw new Error(
      `另一个会话正在启动引擎（锁 ${lockPath}，持有者 pid ${holder?.pid ?? '未知'}），`
        + `${waitMs}ms 内没等到它就绪。请稍等重试；若确认对方已崩溃，删掉该锁文件即可。`,
    )
  }

  try {
    return await startEngine({ engineDir, port, platform, waitMs, pollMs, fetchImpl, spawnImpl, options })
  } finally {
    await lock.release()
  }
}

/** 真正拉起引擎并等就绪；调用方保证持锁。 */
async function startEngine({ engineDir, port, platform, waitMs, pollMs, fetchImpl, spawnImpl, options }) {
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

  // 启动器起不来时 `defaultSpawn` 把错误记在 `child.spawnError`（异步 'error' 事件，
  // 到这里通常已经落定）；拼进超时文案，让"目录错一层"这类问题一眼可见。
  const reason = child?.spawnError ? `；启动失败：${child.spawnError.message}` : ''

  // 超时必须回收自己拉起的那个进程树：否则它会一直占着端口与 512 MB 内存，
  // 而调用方手里没有 pid（ensure 是抛错返回的），永远清不掉。
  const killImpl = options.killImpl ?? stopEngine
  let killed = ''
  if (Number.isInteger(pid) && child?.spawnError === undefined) {
    try {
      await killImpl(pid)
      killed = `；已终止未就绪的进程 pid ${pid}`
    } catch {
      killed = `；终止进程 pid ${pid} 失败，请手动结束`
    }
  }

  throw new Error(
    `引擎在 ${waitMs}ms 内未就绪（端口 ${port}）；日志：${logFile}；目录：${engineDir}${reason}${killed}`,
  )
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
 * 启动器绝对路径。
 *
 * `engineDir` 的**主约定**是引擎产物目录本身，即直接包含 `wrapper-lite-qemu.exe`
 * 与 `qemu/` 的那一层：`<state>/engine/wrapper-lite-qemu`。`deps.js` 的 `plan()`
 * 已按此布局产出，其返回的 `engine.path` 的 `dirname` 就是这一层，Task 10/12 原样透传。
 *
 * 下面的 basename 探测只是**兼容兜底**：万一调用方传的是引擎根 `<state>/engine`，
 * 再补一层 `wrapper-lite-qemu/`。它不是与主约定等价的可选写法。
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

/**
 * 默认 `spawnImpl`：detached 起启动器，stdout/stderr 落到 `opts.logFile`。
 *
 * `spawn` 的失败（典型是启动器路径不存在 → `ENOENT`）不是同步抛出，而是异步 `'error'`
 * 事件；没有监听器就是未捕获异常，会直接打死宿主进程。这里吞掉并记录到
 * `child.spawnError`，让 `ensureEngine` 的轮询自然超时、再抛带路径的可读错误。
 */
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
    // 不 rethrow：进程起不来时交由轮询超时报告，宿主必须活着。
    child.on?.('error', (err) => {
      child.spawnError = err
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
