/**
 * `amdl_match` 的薄接线：只做 `ctx.tools.register(defineTool(...))`。
 * 逻辑在 `../lib/match.js`（那份在纯 Node 下可 import，本文件不行）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { startJob } from '../lib/job.js'
import { playlistIdOf, runMatch } from '../lib/match.js'
import { workDirFor } from '../lib/paths.js'
import { rootFor } from '../lib/setup.js'

export function registerMatchTool(ctx, config = {}) {
  ctx.tools.register(defineTool({
    name: 'amdl_match',
    // 不声明 timeoutMs：这是 job 类工具，execute 立刻返回 jobId，长活由 job 承载。
    description:
      'Match a NetEase Cloud Music playlist against the Apple Music catalog and produce a '
      + 'downloadable list. Start it with a playlist URL or id; it returns a jobId and the working '
      + 'directory immediately, and runs asynchronously — poll progress with job_output. '
      + 'Pipeline: fetch the playlist, refresh the Apple catalog token if it expires within 24 h, '
      + 'search jp/cn/hk, then re-resolve each hit into the account storefront so amdl can fetch a key. '
      + 'Outputs in the working directory: pl.json, pl-match-report.json (per-track verdicts), '
      + 'pl-download-cn.json (machine-readable, has url/duplicate), pl-cn-report.md (human), '
      + 'pl-download-cn.txt (URLs). Tiers A-name and B-duration+album are directly downloadable; '
      + 'C-* need review; D-no not found; retry means the query failed. Tracks with no account-region '
      + 'asset are reported separately and never counted as "not found".',
    parameters: {
      playlistUrl: {
        type: 'string',
        required: true,
        description: 'NetEase playlist URL (any of https://music.163.com/#/playlist?id=..., '
          + 'https://y.music.163.com/m/playlist?id=...&userid=...) or a bare numeric playlist id.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          workDir: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    execute(args, exec) {
      const root = rootFor(config)
      const workDir = workDirFor(root, playlistIdOf(args.playlistUrl))
      const owner = exec?.agent?.id

      const jobId = startJob({
        jobs: ctx.jobs,
        owner: owner === undefined ? undefined : String(owner),
        toolCall: exec?.toolCall,
        kind: 'amdl-match',
        label: `匹配歌单 ${args.playlistUrl}`,
        // 抛出而不是返回 {error}：注册表把 done 的 reject 结算成 `failed`，
        // 返回对象只会得到一个显示为 `completed` 的失败 job。
        work: async ({ append, isCancelled }) => {
          try {
            const r = await runMatch({ playlistUrl: args.playlistUrl, root, config, append, isCancelled })
            append(
              `匹配完成：可下载 ${r.download} / 需复核 ${r.review} / 未找到 ${r.notFound}`
                + ` / 请求失败 ${r.retry} / 账号区无资产 ${r.accountMissing}`,
            )
            append(`产物：${r.reportPath}`)
            return `匹配完成：可下载 ${r.download} / 需复核 ${r.review}`
          } catch (err) {
            append(`匹配失败：${err?.message ?? err}`)
            throw err
          }
        },
      })

      return {
        jobId,
        workDir,
        summary: `已启动匹配（job ${jobId}），用 job_output 看进度；产物目录 ${workDir}`,
      }
    },
  }))
}