/**
 * `amdl_download` 的薄接线：只做 `ctx.tools.register(defineTool(...))`。
 * 逻辑在 `../lib/download.js`（那份在纯 Node 下可 import，本文件不行）。
 */
import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { detectMode, formatDownloadSummary, runDownloads, urlsFromResolved } from '../lib/download.js'
import { startJob } from '../lib/job.js'
import { rootFor } from '../lib/setup.js'

/**
 * 读歌单模式的上游产物 `pl-download-cn.json`（由 `amdl_match` 写出）。
 *
 * 文件缺失说明 workDir 给错了层（那是匹配的工作目录，不是随便一个目录）。
 */
async function urlsFromWorkDir(workDir) {
  const file = `${String(workDir).replace(/[\\/]+$/, '')}/pl-download-cn.json`
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new Error(
      `在 ${file} 找不到换籍结果。workDir 应是 amdl_match 返回的那个目录；`
        + '请先跑 amdl_match，或改用 urls 参数直接给 Apple Music 链接。',
    )
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`${file} 不是合法 JSON：${err?.message ?? err}。重跑 amdl_match 生成一份新的。`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${file} 的形状不对：期望数组，实得 ${parsed === null ? 'null' : typeof parsed}。`)
  }
  return urlsFromResolved(parsed)
}

export function registerDownloadTool(ctx, config = {}) {
  ctx.tools.register(defineTool({
    name: 'amdl_download',
    // 不声明 timeoutMs：这是 job 类工具，execute 立刻返回 jobId，长活由 job 承载。
    description:
      'Download Apple Music tracks to ALAC files through the local amdl + wrapper-lite engine. '
      + 'Two mutually exclusive input modes: `workDir` (playlist mode — pass the directory amdl_match '
      + 'returned; it reads pl-download-cn.json and skips empty URLs and duplicates) or `urls` (direct '
      + 'mode — one or more https://music.apple.com/... links, no matching step needed). It returns a '
      + 'jobId immediately and runs in the background; poll with job_output. Album and artist links '
      + 'expand to many tracks, so one "URL" can mean a whole record. Keep the `?i=<trackId>` query '
      + 'parameter — a bare album URL loses the track selection. Downloads are strictly serial: one '
      + 'amdl process at a time, which parallelizes inside a single file itself. A link for a storefront '
      + 'other than your account region fails with key code=500 and gets reported as account-region '
      + 'mismatch, not as a generic failure. At the end it re-checks audio quality with verify-alac.js '
      + 'and lists suspicious leftovers (cover-only folders, zero-byte .m4a) without deleting anything.',
    parameters: {
      workDir: {
        type: 'string',
        description: 'Playlist mode: the workDir returned by amdl_match (contains pl-download-cn.json).',
      },
      urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'Direct mode: Apple Music track/album/artist URLs. Mutually exclusive with workDir.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      if (ctx.jobs === undefined || ctx.jobs === null) {
        throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
      }
      const mode = detectMode(args)
      const root = rootFor(config)
      const urls = mode === 'playlist'
        ? await urlsFromWorkDir(args.workDir)
        : args.urls.map((url, i) => ({ idx: i + 1, url: String(url) }))

      if (urls.length === 0) {
        throw new Error('没有可下载的曲目：清单是空的。可能是匹配 0 命中、全部为账号区无资产，'
          + '或全部是重复项 —— 详见 workDir 里的 pl-cn-report.md；也可以直接用 urls 给 Apple Music 链接。')
      }

      const owner = exec?.agent?.id
      const jobId = startJob({
        jobs: ctx.jobs,
        owner: owner === undefined ? undefined : String(owner),
        toolCall: exec?.toolCall,
        kind: 'amdl-download',
        label: `下载 ${urls.length} 首（${mode}）`,
        // 抛出而不是返回 {error}：注册表把 done 的 reject 结算成 `failed`。
        work: async ({ append, isCancelled, registerCancel }) => {
          try {
            const r = await runDownloads({
              urls, root, config, mode, append, isCancelled, registerCancel,
            })
            if (r.loginRequired) {
              throw new Error('登录态失效（引擎 /status 的 regions 为空），请按上游文档在 QEMU 串口重新登录。'
                + '不要删 data.img —— 里面是登录态。')
            }
            // 模型能确定拿到的只有 result：产物目录、逐首路径、音质都必须并进返回值，
            // 不能只 append 到 ring（2026-11-19 实测模型被迫自己去翻 output 目录）。
            const summary = formatDownloadSummary(r)
            append(summary)
            return summary
          } catch (err) {
            append(`下载失败：${err?.message ?? err}`)
            throw err
          }
        },
      })

      return {
        jobId,
        mode,
        summary: `已启动下载（job ${jobId}，${urls.length} 首，${mode} 模式），用 job_output 看进度`,
      }
    },
  }))
}
