import path from 'node:path'
import os from 'node:os'

const APP = 'dsh-amdl-suite'

export function stateDir(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? os.homedir()
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local')
    return path.win32.join(base, APP)
  }
  const base = env.XDG_DATA_HOME ?? path.posix.join(home, '.local', 'share')
  return path.posix.join(base, APP)
}

const joinFor = (root) => (String(root).includes('\\') ? path.win32 : path.posix)

export function pathsFor(root) {
  const j = joinFor(root).join
  return {
    engine: j(root, 'engine'),
    bin: j(root, 'bin'),
    data: j(root, 'data'),
    config: j(root, 'config'),
    state: j(root, 'state'),
    work: j(root, 'work'),
    output: j(root, 'output'),
    logs: j(root, 'logs'),
  }
}

export function workDirFor(root, playlistId) {
  return joinFor(root).join(root, 'work', String(playlistId))
}
