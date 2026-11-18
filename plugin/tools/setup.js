/**
 * `amdl_setup` 的薄接线：只做 `ctx.tools.register(defineTool(...))`，
 * 逻辑全部在 `../lib/setup.js`（该文件在纯 Node 下可 import，本文件不行）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { rootFor, runSetup } from '../lib/setup.js'

const ACTIONS = ['plan', 'fetch-amdl', 'fetch-engine', 'verify']

export function registerSetupTool(ctx, config = {}) {
  ctx.tools.register(defineTool({
    name: 'amdl_setup',
    // 刻意不声明 timeoutMs：`dsh-tool-call-timeout-policy` 不中断工具，只在结束时把**成功**结果
    // 替换成 `tool call timed out`；而本工具不消费 exec.signal，设了它唯一的效果是
    // "慢链路成功后被报成失败"，与 design §6.6「不设硬超时」直接冲突。
    description:
      'Fetch and verify the two runtime dependencies of this plugin: the wrapper-lite QEMU engine '
      + '(pinned CI run artifact, ~158 MB) and the amdl downloader (GitHub release asset). '
      + 'Actions: `plan` reports what is missing, where artifacts land, target run_id and expected '
      + 'size/duration without downloading anything — run it first; `fetch-amdl` downloads amdl plus '
      + 'checksums.txt and installs it to `bin/` after SHA256 verification (~4 s); `fetch-engine` '
      + 'downloads the engine zip (157,822,346 B), verifies its sha256, then extracts it into '
      + '`engine/wrapper-lite-qemu/` (~225 s at 1 MB/s, much longer on slow links; the zip is kept so '
      + 'a re-run re-extracts instead of downloading again); `verify` checks all five installed files. '
      + 'A checksum mismatch refuses installation and deletes the download instead of leaving a broken '
      + 'artifact behind. Requires about 800 MB free disk (640 MB extracted + the kept zip).',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ACTIONS,
        description: '`plan` (probe only), `fetch-amdl`, `fetch-engine`, or `verify`.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string' },
                size: { type: 'integer' },
                problem: { type: 'string' },
                present: { type: 'boolean' },
                reason: { type: 'string' },
              },
            },
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      return runSetup({
        action: args.action,
        root: rootFor(config),
        platform: process.platform,
        config,
      })
    },
  }))
}
