/**
 * 杀掉一个进程**及其子进程**（design §6.7：cancel 必须真的停掉进程树）。
 *
 * `child.kill()` 只结束直接子进程；amdl / vendor 脚本派生出的进程会活下来，
 * 会话关掉后仍在跑。Windows 用 `taskkill /T /F`，其它平台退化成按 pid 杀
 * （第一版只做 Windows，见 design §7）。
 */
import { spawn } from 'node:child_process'

export function killTree(pid) {
  if (!Number.isInteger(pid)) return
  if (process.platform === 'win32') {
    const proc = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true })
    // 进程已退出时 taskkill 返回非零；不接住异步 'error' 会变成未捕获异常崩宿主
    proc.on?.('error', () => {})
    proc.unref?.()
    return
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
}
