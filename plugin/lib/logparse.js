export function splitLines(chunk) {
  const parts = String(chunk).split(/\r\n|\r|\n/)
  const rest = parts.pop() ?? ''
  return { lines: parts.filter((l) => l.length > 0), rest }
}

const PROGRESS = /^(Downloading|Decrypting)\.\.\.\s+(\d+)%/

export function parseLine(line) {
  const s = String(line).trim()
  if (s.length === 0) return null
  const m = PROGRESS.exec(s)
  if (m) {
    return { kind: m[1] === 'Downloading' ? 'download' : 'decrypt', percent: Number(m[2]) }
  }
  if (s.includes('Decrypted') || s.includes('Audio integrity intact')) return { kind: 'done' }
  if (s.includes('key returned code=500')) return { kind: 'key500' }
  if (s.includes('Unavailable, trying to dl aac-lc')) return { kind: 'aac' }
  if (s.includes('Track already exists locally')) return { kind: 'exists' }
  if (/^Track \d+ of \d+:/.test(s)) return { kind: 'track' }
  return null
}

export function classify(log) {
  const text = String(log)
  if (text.includes('key returned code=500')) return 'key500'
  if (text.includes('Unavailable, trying to dl aac-lc')) return 'aac'
  if (text.includes('Track already exists locally')) return 'exists'
  if (text.includes('Decrypted') || text.includes('Audio integrity intact')) return 'ok'
  return 'unknown'
}
