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
      storefront,
      'exit-on-error': true,
    },
    media: { 'get-m3u8-mode': 'hires', 'alac-max': alacMax },
    paths: { alac: alacDir },
    metadata: {
      lyrics: { embed: true, format: 'lrc' },
      artwork: { embed: true, size: '5000x5000' },
    },
    convert: { 'after-download': false },
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
 * @param {{
 *   amdlPath: string,
 *   configPath: string,
 *   url: string,
 *   spawnImpl?: Function,
 *   onLine?: (line: string, parsed: { kind: string, percent?: number } | null) => void,
 * }} options
 * @returns {Promise<{ url: string, path: string | null, verdict: string, log: string, exitCode: number }>}
 */
export function downloadOne(options) {
  const { amdlPath, configPath, url, onLine } = options
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

    proc.stdout?.on('data', onChunk)
    proc.stderr?.on('data', onErrChunk)
    proc.on('error', reject)
    proc.on('close', (code) => {
      onChunk.flush()
      onErrChunk.flush()
      const verdict = classify(log)
      const path = verdict === 'key500' || verdict === 'exists' ? null : artifactPathOf(lines)
      resolve({ url, path, verdict, log, exitCode: code ?? -1 })
    })
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
