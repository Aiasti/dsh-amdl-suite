/**
 * 把一段长时间运行的 `work` 包装成 DSH 后台 job。
 *
 * job 被 kill 时 DSH 只调用 `cancel(reason)`，真正的收尾（停引擎、杀 amdl 进程树）
 * 由 `work` 通过 `registerCancel(fn)` 登记。这里保证这些钩子：
 * - 被 kill 时执行；
 * - 正常结束时也执行（`finally`）；
 * - 只执行一次，`cancel` 多次调用也不会重复清理。
 *
 * `done` 必须结算成 `JobOutcome`（`{status, detail?, result?}`）：注册表直接执行
 * `job.status = outcome.status`，其余状态值都不是终态，job 会永远停在 `running`。
 * `work` 直接返回字符串时视为"完成 + 结果"；被取消后返回则结算成 `killed`。
 *
 * @param {object} options
 * @param {{ start(spec: object): string }} options.jobs DSH job 注册表
 * @param {string} options.owner 会话 id
 * @param {object} options.toolCall 触发本次 job 的工具调用
 * @param {string} options.kind job 类型
 * @param {string} options.label 展示用标签
 * @param {(ctx: { append: (text: unknown) => void, isCancelled: () => boolean, registerCancel: (fn: () => void) => void }) => Promise<unknown>} options.work
 * @returns {string} jobId
 */
export const startJob = ({ jobs, owner, toolCall, kind, label, work }) =>
  jobs.start({
    kind,
    label,
    owner,
    toolCall,
    run(job) {
      let cancelled = false
      const cancelHooks = []

      const append = (text) => job.append(String(text), { channel: 'log' })
      const isCancelled = () => cancelled
      const registerCancel = (fn) => {
        if (typeof fn === 'function') cancelHooks.push(fn)
      }

      /**
       * 执行已登记的清理钩子。`splice` 先把列表取走再执行，所以：
       * - 同一批钩子只会跑一次，`cancel` 调两次也不会重复清理；
       * - `cancel` 之后才登记的钩子（work 还没走到注册那一步）不会被漏掉，
       *   `finally` 会兜底执行剩下的。
       */
      const runCancel = () => {
        const hooks = cancelHooks.splice(0)
        for (const fn of hooks) {
          // 清理失败不能掩盖 work 本来的结果或错误
          try { fn() } catch { /* ignore */ }
        }
      }

      /**
       * `work` 的返回值 → 注册表要的 `JobOutcome`。
       *
       * 注册表执行 `job.status = outcome.status`（dsh-jobs-local:771），而
       * `completed/killed/failed` 之外的任何值都不算终态 —— 直接把 `work` 的返回
       * 对象交出去，job 会永远停在 `running`，模型也永远收不到结算通知。
       * `result` 只收字符串：结构化结果由 `work` 自己 append 到 ring。
       */
      const outcomeOf = (value) => {
        if (cancelled) return { status: 'killed' }
        return typeof value === 'string'
          ? { status: 'completed', result: value }
          : { status: 'completed' }
      }

      const done = Promise.resolve()
        .then(() => work({ append, isCancelled, registerCancel }))
        .then(outcomeOf)
        // 被 kill 之后 work 往往以"进程被杀"的错误收场。那个错误不是失败，
        // 不该让 job 显示 failed + 一条无关错误 —— 结算成 killed，与状态一致。
        .catch((err) => {
          if (cancelled) return { status: 'killed' }
          throw err
        })
        .finally(() => runCancel())

      return {
        cancel: () => {
          cancelled = true
          runCancel()
        },
        done,
      }
    },
  })
