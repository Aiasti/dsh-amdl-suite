import z from '@deepseek-ai/schemastery'

/**
 * 插件配置（design §6.9）。
 *
 * **本文件不得被任何测试 import**：`@deepseek-ai/schemastery` 只由 DSH 运行期的解析
 * 拦截层提供，纯 Node 下 `ERR_MODULE_NOT_FOUND`（Ruling 20）。
 */
export const Config = z.object({
  engineDir: z.string().default('').description('用户自备引擎目录；留空用状态目录'),
  amdlPath: z.string().default('').description('用户自备 amdl 可执行文件；留空用状态目录'),
  storefronts: z.string().default('jp,cn,hk').description('检索区，逗号分隔'),
  accountStorefront: z.string().default('').description('账号区（C/D 复核用）；留空按 live /status 或 state/account.json 解析'),
  outputDir: z.string().default('').description('下载落位；留空用状态目录 output/'),
  alacMax: z.natural().default(192000).description('音质上限'),
  engineRunId: z.string().default('41577514031').description('钉住的 wrapper-lite CI run id'),
  engineSha256: z.string().default('sha256:67a21f33db9780d081f1a5086f7553b4ab501329be06865647bd01355fae87f1').description('与 engineRunId 配套的资产校验和'),
  stagnationSeconds: z.natural().default(60).description('无输出多久算可疑（只提示，不退出）'),
  mirror: z.string().default('').description('可选下载镜像前缀'),
})
