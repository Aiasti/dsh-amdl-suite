/**
 * `amdl_setup` 的薄接线：只做 `ctx.tools.register(defineTool(...))`，
 * 逻辑全部在 `../lib/setup.js`（该文件在纯 Node 下可 import，本文件不行）。
 */
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runSetup } from '../lib/setup.js'
import { stateDir } from '../lib/paths.js'

const ACTIONS = ['plan', 'fetch-amdl', 'fetch-engine', 'verify']

/**
 * 工具调用上限。**不是"预期耗时"**：正常 157 MB / 0.7 MB/s ≈ 225 s，但 design §8
 * 记录的真实下限是 40 KB/s —— 那时要 65 分钟。留到 2 小时，避免慢链路被中途掐断
 * （design §6.6 明确"不设硬超时，进度如实汇报"）。
 */
const TIMEOUT_MS = 7200000

/**
 * 状态根目录。
 *
 * `engineDir` 是**引擎产物目录本身**，即 `<root>/engine/wrapper-lite-qemu`（Ruling 12），
 * 所以根目录要往上两层。留空则用 `stateDir()`。
 *
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
function rootFor(config) {
  const engineDir = typeof config?.engineDir === 'string' ? config.engineDir.trim() : ''
  if (engineDir !== '') return path.dirname(path.dirname(path.resolve(engineDir)))
  return stateDir()
}

export function registerSetupTool(ctx, config = {}) {
  ctx.tools.register(defineTool({
    name: 'amdl_setup',
    description:
      'Fetch and verify the two runtime dependencies of this plugin: the wrapper-lite QEMU engine '
      + '(pinned CI run artifact, ~158 MB) and the amdl downloader (GitHub release asset). '
      + 'Actions: `plan` reports what is missing, where artifacts land, target run_id and expected '
      + 'size/duration without downloading anything — run it first; `fetch-amdl` downloads amdl plus '
      + 'checksums.txt and installs it to `bin/` after SHA256 verification (~4 s); `fetch-engine` '
      + 'downloads the engine zip, verifies its sha256, then extracts it into `engine/` (~225 s at '
      + '1 MB/s, much longer on slow links; the zip is kept so a re-run re-extracts instead of '
      + 'downloading again); `verify` checks all five installed files. A checksum mismatch refuses '
      + 'installation and deletes the download instead of leaving a broken artifact behind.',
    timeoutMs: TIMEOUT_MS,
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
