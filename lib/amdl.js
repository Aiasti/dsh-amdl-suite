import { spawn } from 'node:child_process'
import { classify, parseLine, splitLines } from './logparse.js'

/**
 * amdl 配置对象（可直接喂 `toYaml`）。
 *
 * `exit-on-error: true` 是硬要求：设成 `false` 时 amdl 遇到错误会无限重试、永不退出。
 *
 * @param {{ liteServer: string, storefront: string, alacDir: string, alacMax: number }} options
 * @returns {object}
 */
export function buildConfig({ liteServer, storefront, alacDir, alacMax }) {
  return {
    general: {
      'lite-server': liteServer,
      'media-user-token': '',
      language: '',
      'max-memory-limit': 256,
      proxy: '',
      storefront,
      'authorization-token': '',
      'exit-on-error': true,
    },
    media: {
      'get-m3u8-mode': 'hires',
      'alac-max': alacMax,
      'atmos-max': 2768,
      'aac-type': 'aac-lc',
      'alac-fix': true,
      mv: { 'audio-type': 'atmos', max: 2160 },
    },
    paths: {
      alac: alacDir,
      atmos: 'AM-Atmos',
      aac: 'AM-AAC',
      mv: 'AM-MV',
      'album-folder': '{AlbumName}',
      'playlist-folder': '{PlaylistName}',
      'artist-folder': '{UrlArtistName}',
      'song-file': '{SongNumer}. {SongName}',
      'limit-max': 200,
      explicit: '[E]',
      clean: '[C]',
      'apple-master': '[M]',
    },
    metadata: {
      lyrics: { 'save-file': false, embed: true, type: 'lyrics', format: 'lrc', extra: '' },
      artwork: {
        embed: true,
        size: '5000x5000',
        format: 'jpg',
        'save-artist': false,
        'save-animated': false,
        'emby-animated': false,
        'dl-for-playlist': false,
      },
      tags: { 'sort-order': true, 'itunes-id': true, 'use-songinfo-for-playlist': false },
    },
    convert: {
      'after-download': false,
      format: 'flac',
      'keep-original': false,
      'skip-if-source-matches': true,
      'ffmpeg-path': 'ffmpeg',
      'extra-args': '',
      'with-metadata': true,
      'warn-lossy-to-lossless': true,
      'skip-lossy-to-lossless': true,
      'check-bad-alac': false,
      'delete-bad-alac': false,
    },
  }
}

/**
 * amdl 参数。v0.1.4 没有 `--input`/`--output`/`--concurrency`，URL 走位置参数。
 *
 * @param {string} configPath
 * @param {string} url
 * @returns {string[]}
 */
export function amdlArgsFor(configPath, url) {
  return ['-c', configPath, '--json', url]
}

/**
 * 解析 `--json` 输出的那行数组，取 `[0]`。非数组、空数组、非法 JSON 一律 `null`。
 *
 * @param {string} line
 * @returns {{ path: string, artist?: string, album?: string, song?: string } | null}
 */
export function parseJsonSummary(line) {
  let parsed
  try {
    parsed = JSON.parse(String(line).trim())
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const first = parsed[0]
  if (first === null || typeof first !== 'object') return null
  if (typeof first.path !== 'string' || first.path.length === 0) return null
  return first
}

/**
 * 跑一个 amdl 进程，收集全部输出，给出判定与产物路径。
 *
 * 判定用 `classify`（整段文本扫描）而不是逐行 `parseLine`：amdl 会把标记追加在进度行同一行，
 * 逐行的进度正则先匹配就返回了，尾部的 `key500` / `Decrypted` 会看不见。
 *
 * `key500` 与 `exists` 时 amdl 不输出产物路径，`path` 置 `null`。
 *
 * `verdict` 取值：`ok` | `key500` | `aac` | `exists` | `unknown`（来自 `classify`），
 * 外加本函数产生的 `timeout`（超时）与 `cancelled`（`signal` 中止），这两种 `path` 均为 `null`。
 *
 * 超时或中止时优先调 `killTree(pid)` 清理**进程树**（design §6.7：只杀直接子进程会留下
 * amdl 派生的子进程）；没给 `killTree` 时退回 `proc.kill()`。
 *
 * @param {{
 *   amdlPath: string,
 *   configPath: string,
 *   url: string,
 *   spawnImpl?: Function,
 *   onLine?: (line: string, parsed: { kind: string, percent?: number } | null) => void,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   killTree?: (pid: number) => void,
 * }} options
 * @returns {Promise<{ url: string, path: string | null, verdict: string, log: string, exitCode: number }>}
 */
export function downloadOne(options) {
  const { amdlPath, configPath, url, onLine, timeoutMs, signal, killTree } = options
  const spawnImpl = options.spawnImpl ?? spawn

  return new Promise((resolve, reject) => {
    const proc = spawnImpl(amdlPath, amdlArgsFor(configPath, url), { windowsHide: true })
    const lines = []
    let log = ''

    proc.stdout?.setEncoding?.('utf8')
    proc.stderr?.setEncoding?.('utf8')

    // stdout 与 stderr 各自维护残行：两个流交错到达时，不能把一段 stdout 的半行接在 stderr 上。
    const reader = () => {
      let rest = ''
      const feed = (chunk) => {
        const text = String(chunk)
        log += text
        const split = splitLines(rest + text)
        rest = split.rest
        for (const line of split.lines) {
          lines.push(line)
          onLine?.(line, parseLine(line))
        }
      }
      // 末尾没换行时最后一行还在残行里，收尾时补发一次。
      feed.flush = () => {
        if (rest.length === 0) return
        const last = rest
        rest = ''
        lines.push(last)
        onLine?.(last, parseLine(last))
      }
      return feed
    }
    const onChunk = reader()
    const onErrChunk = reader()

    let settled = false
    let forced = null
    let timer = null
    let closeCode = -1

    // 只落定一次：close 与 timeout/abort 谁先到算谁。落定时清掉定时器与 abort 监听，不留悬挂计时器。
    // `forced` 先赋值再 kill，即使 kill 同步触发 close，timeout/cancelled 也不会被 classify 覆盖。
    const settle = () => {
      if (settled) return
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      signal?.removeEventListener?.('abort', onAbort)
      onChunk.flush()
      onErrChunk.flush()
      const verdict = forced ?? classify(log)
      // timeout / cancelled 没有产物；key500 / exists 时 amdl 不输出路径。
      const path = forced !== null || verdict === 'key500' || verdict === 'exists'
        ? null
        : artifactPathOf(lines)
      resolve({ url, path, verdict, log, exitCode: closeCode })
    }

    // 停进程树：给了 killTree 就按 pid 走（Windows 用 taskkill /T），否则退化成杀直接子进程。
    const killNow = () => {
      const pid = proc.pid
      if (typeof killTree === 'function' && Number.isInteger(pid)) {
        try { killTree(pid) } catch { /* 清理失败不能让 Promise 挂住 */ }
        // taskkill 可能失败（权限、进程已退出）：再补一刀直接子进程，
        // 否则 Promise 会一直挂在没有 'close' 的子进程上
        try { proc.kill?.() } catch { /* 已退出 */ }
        return
      }
      proc.kill?.()
    }

    // 只杀自己 spawn 的子进程；进程树清理（taskkill /T）由调用方通过 killTree 提供。
    const onAbort = () => {
      forced = 'cancelled'
      killNow()
      settle()
    }

    proc.stdout?.on('data', onChunk)
    proc.stderr?.on('data', onErrChunk)
    proc.on('error', (err) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      reject(err)
    })
    proc.on('close', (code) => {
      closeCode = code ?? -1
      settle()
    })

    if (timeoutMs !== undefined && timeoutMs !== null) {
      timer = setTimeout(() => {
        forced = 'timeout'
        killNow()
        settle()
      }, timeoutMs)
    }

    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** 从所有行里找第一个能解析成 JSON 摘要的行，取其 `path`。 */
function artifactPathOf(lines) {
  for (const line of lines) {
    const summary = parseJsonSummary(line)
    if (summary !== null) return summary.path
  }
  return null
}
