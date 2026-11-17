function quoted(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function scalar(v) {
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'number') return String(v)
  return quoted(v)
}

function walk(obj, indent, out) {
  const pad = ' '.repeat(indent)
  for (const [k, v] of Object.entries(obj)) {
    // 顶层配置键保持裸写，嵌套键加引号
    const key = indent === 0 ? String(k) : quoted(k)
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(`${pad}${key}:`)
      walk(v, indent + 2, out)
    } else {
      out.push(`${pad}${key}: ${scalar(v)}`)
    }
  }
}

export function toYaml(value) {
  const out = []
  walk(value, 0, out)
  return out.length === 0 ? '{}\n' : out.join('\n') + '\n'
}
