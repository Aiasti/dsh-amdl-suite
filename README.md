# dsh-amdl-suite

一个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）宿主插件：把**网易云歌单**或 **Apple Music 链接**下载成本地 ALAC 文件。没有前端页面，全部通过模型侧工具完成。

底层复用两个开源项目，**既不内置也不改动**，只取它们的官方 release 产物：

| 项目 | 作用 |
|---|---|
| [zhaarey/apple-music-downloader](https://github.com/zhaarey/apple-music-downloader)（amdl） | 下载与解密 |
| [WorldObservationLog/wrapper](https://github.com/WorldObservationLog/wrapper/tree/lite)（wrapper-lite） | 提供 `/key` 解密服务（QEMU 里的 Apple Music app） |

## 三个工具

| 工具 | 做什么 |
|---|---|
| `amdl_setup` | 拉取并校验上面两个依赖（`plan` / `fetch-amdl` / `fetch-engine` / `verify`） |
| `amdl_match` | 网易云歌单 → 跨区检索 Apple Music → 换籍，产出可下载清单（后台 job） |
| `amdl_download` | 按清单或直链串行下载，收尾复核音质（后台 job） |

## 环境要求

- **Windows**（第一版只支持 Windows；Linux/macOS 未实测）
- Node.js ≥ 22
- 约 800 MB 空闲磁盘（引擎解压 640 MB + 保留的 zip 157 MB）
- Apple Music 订阅（解密需要账号态）

## 安装

插件以 **bundle** 形式装进 DSH profile。**不要用 `link:` 安装** —— link 的真实路径在 profile 之外，宿主的模块解析层覆盖不到 `@deepseek-ai/*`，插件会加载失败。

```powershell
cd plugin
npm pack --pack-destination ..\dist
```

然后在 DSH 里用 `plugin_manager`：

```
install_bundle  target = <仓库>\dist\dsh-amdl-suite-1.0.0.tgz
```

装好后重启 DSH，三个工具就出现在模型侧。

## 用法

```
amdl_setup({ action: "plan" })          # 先看缺什么、产物会落在哪
amdl_setup({ action: "fetch-amdl" })    # 约 15 MB
amdl_setup({ action: "fetch-engine" })  # 约 158 MB，解压 640 MB
amdl_setup({ action: "verify" })        # 5 项全绿即可
```

```
amdl_match({ playlistUrl: "https://music.163.com/#/playlist?id=..." })
# → { jobId, workDir }；用 job_output 看进度
#   产物：pl-match-report.json / pl-download-cn.json / pl-cn-report.md …

amdl_download({ workDir: "<上一步的 workDir>" })   # 歌单模式
amdl_download({ urls: ["https://music.apple.com/cn/album/x/1?i=2"] })  # 直链模式
```

两种模式**互斥**。专辑/歌手链接会展开成多首，所以一个「URL」可能是一整张专辑。

## 登录（只需一次）

amdl 的解密密钥来自 wrapper-lite 里那个已登录的 Apple Music app，所以**第一次使用前**要在 QEMU 里登录一次：

```powershell
%LOCALAPPDATA%\dsh-amdl-suite\engine\wrapper-lite-qemu\wrapper-lite-qemu.exe --login <appleid>:<password>
```

登录态写进 `data.img`，之后不用重复。插件**不接触密码**，只检测 `/status` 的 `regions` 是否为空并给出指引。

> 如果登录报 `SSL_ERROR_SYSCALL in connection to auth.itunes.apple.com`：是本地代理（TUN + fake-IP）把这个域名路由坏了，不是凭据问题。关掉代理走直连即可。

## 产物落位

默认状态目录：

- Windows：`%LOCALAPPDATA%\dsh-amdl-suite\`
- Linux：`$XDG_DATA_HOME/dsh-amdl-suite/`（未实测）

```
dsh-amdl-suite/
├── bin/amdl.exe
├── engine/wrapper-lite-qemu/     # 引擎产物目录（含 qemu/data.img 登录态）
├── engine/wrapper-lite-qemu.zip  # 保留下来的 artifact
├── config/amdl.yaml              # 每次运行重写
├── work/<歌单id>/                # 匹配产物
└── output/                       # 下载的音乐
```

## 配置

在 DSH 的插件配置里设置（全部可选）：

| 键 | 默认 | 说明 |
|---|---|---|
| `engineDir` | 空 | 自备引擎产物目录，必须是 `<root>/engine/wrapper-lite-qemu` 形状 |
| `amdlPath` | 空 | 自备 amdl 可执行文件 |
| `storefronts` | `jp,cn,hk` | 检索区 |
| `outputDir` | 空 | 下载落位 |
| `alacMax` | `192000` | 音质上限 |
| `engineRunId` / `engineSha256` | 钉住的 CI run | 升级引擎时两者一起改 |
| `stagnationSeconds` | `60` | 多久无输出算"疑似停滞"。**只提示，不退出** |

## 设计约束

- **不内置、不改动上游两个项目**：只下载它们的 release 产物并校验 sha256。
- **不设硬编码超时**：卡住与否由「疑似停滞」提示交给模型/用户判断。
- **绝不自动删除用户文件**：半成品目录只报告，不清理。
- **串行下载**：一次只跑一个 amdl 进程（它自己在文件内分段并发）。
- **零 npm 运行时依赖**。
- `data.img`（账号登录态）不会被 `fetch-engine` 覆盖 —— 重装引擎时会先挪开再放回。

## 开发

```powershell
cd plugin
node --test          # 155 个用例
```

分层规则（测试要在纯 Node 下能跑）：

- `plugin/lib/*.js` —— 纯逻辑，只能 import `node:*` 与同目录 `lib/`
- `plugin/tools/*.js` —— 薄接线，`import { defineTool } from '@deepseek-ai/dsh-tools'`
- `plugin/lib/config-schema.js` —— 唯一允许 import 宿主包的 lib 文件，**不得被测试 import**

## 已知限制

- 只支持 Windows
- 换籍的「成功」分支、AAC 降级、跨区 key500 只有构造样本，没有真实歌单覆盖
- 锁身份只用 pid，同进程内并发调用 `amdl_setup` 不互斥
- 会话关闭会取消 job 并停掉自己拉起的引擎；复用的他人引擎不会被停

## 许可

MIT，见 [LICENSE](LICENSE)。

运行时下载的两个上游项目同样是 MIT。`plugin/vendor/` 下的匹配/取数脚本为作者自研，随本仓库一同授权。
