# dsh-amdl-suite

A [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）host plugin that aligns NetEase Cloud Music playlists or Apple Music links with your local library and prepares ALAC files. No web UI — everything runs through model-side tools.

插件在 DSH 里的显示名是 **amdl套件 / amdl Suite**。底层复用两个开源项目，**既不内置也不改动**，只取它们的官方 release 产物：

| 项目 | 作用 |
|---|---|
| [zhaarey/apple-music-downloader](https://github.com/zhaarey/apple-music-downloader)（amdl） | 下载与解密 |
| [WorldObservationLog/wrapper](https://github.com/WorldObservationLog/wrapper/tree/lite)（wrapper-lite） | 提供 `/key` 解密服务（QEMU 里的 Apple Music app） |

---

## 中文

### 三个工具

| 工具 | 做什么 |
|---|---|
| `amdl_setup` | 拉取并校验两个依赖（`plan` / `fetch-amdl` / `fetch-engine` / `verify`） |
| `amdl_match` | 网易云歌单 → 跨区检索 → 换籍 → 可下载清单；C/D 档另做账号区复核（`pl-review-account.md`，不自动下载） |
| `amdl_download` | 按清单或直链串行下载，收尾只复核本次产物并报告音质 |

### 环境要求

- **Windows**（第一版只支持 Windows；Linux/macOS 未实测）
- Node.js ≥ 22
- 约 800 MB 空闲磁盘（引擎解压 640 MB + 保留的 zip 157 MB）
- Apple Music 订阅（解密需要账号态）

### 安装

插件以 **bundle** 形式装进 DSH profile，直接从仓库装：

```
plugin_manager → install_bundle
target = https://github.com/Aiasti/dsh-amdl-suite
```

装好后重启 DSH，三个工具就出现在模型侧。

本地改代码后要装自己那份：

```powershell
npm pack --pack-destination dist
# 然后 install_bundle target = <仓库>\dist\dsh-amdl-suite-1.0.2.tgz
```

> **不要用 `link:` 安装** —— link 的真实路径在 profile 之外，宿主的模块解析层覆盖不到 `@deepseek-ai/*`，插件会加载失败。也不要把 bundle 放进子目录：DSH 从仓库根读 `package.json` 的 `dsh.bundle.patch`。

### 用法

```
amdl_setup({ action: "plan" })          # 先看缺什么、产物会落在哪
amdl_setup({ action: "fetch-amdl" })    # 约 15 MB
amdl_setup({ action: "fetch-engine" })  # 约 158 MB，解压 640 MB
amdl_setup({ action: "verify" })        # 5 项全绿即可
```

```
amdl_match({ playlistUrl: "https://music.163.com/#/playlist?id=..." })
# → { jobId, workDir }；用 job_output 看进度
#   产物：pl-match-report.json / pl-download-cn.json / pl-cn-report.md / pl-review-account.md …

amdl_download({ workDir: "<上一步的 workDir>" })   # 歌单模式
amdl_download({ urls: ["https://music.apple.com/cn/album/x/1?i=2"] })  # 直链模式
```

两种模式**互斥**。专辑/歌手链接会展开成多首，所以一个「URL」可能是一整张专辑。

### 登录（只需一次）

amdl 的解密密钥来自 wrapper-lite 里那个已登录的 Apple Music app，所以**第一次使用前**要在 QEMU 里登录一次：

```powershell
%LOCALAPPDATA%\dsh-amdl-suite\engine\wrapper-lite-qemu\wrapper-lite-qemu.exe --login <appleid>:<password>
```

登录态写进 `data.img`，之后不用重复。插件**不接触密码**，只检测 `/status` 的 `regions` 是否为空并给出指引。

> 如果登录报 `SSL_ERROR_SYSCALL in connection to auth.itunes.apple.com`：是本地代理（TUN + fake-IP）把这个域名路由坏了，不是凭据问题。关掉代理走直连即可。

### 产物落位

默认状态目录：

- Windows：`%LOCALAPPDATA%\dsh-amdl-suite\`
- Linux：`$XDG_DATA_HOME/dsh-amdl-suite/`（未实测）

```
dsh-amdl-suite/
├── bin/amdl.exe
├── engine/wrapper-lite-qemu/     # 引擎产物目录（含 qemu/data.img 登录态）
├── engine/wrapper-lite-qemu.zip  # 保留下来的 artifact
├── config/amdl.yaml              # 每次运行重写（完整模板）
├── state/account.json            # 最近一次已知的账号区
├── work/<歌单id>/                # 匹配产物 + 账号区复核
└── output/                       # 下载的音乐
```

### 配置

在 DSH 的插件配置里设置（全部可选）：

| 键 | 默认 | 说明 |
|---|---|---|
| `engineDir` | 空 | 自备引擎产物目录，必须是 `<root>/engine/wrapper-lite-qemu` 形状 |
| `amdlPath` | 空 | 自备 amdl 可执行文件 |
| `storefronts` | `jp,cn,hk` | 检索区 |
| `accountStorefront` | 空 | 账号区，用于 C/D 档复核；空 = 自动解析 |
| `outputDir` | 空 | 下载落位 |
| `alacMax` | `192000` | 音质上限 |
| `engineRunId` / `engineSha256` | 钉住的 CI run | 升级引擎时两者一起改 |
| `stagnationSeconds` | `60` | 多久无输出算“疑似停滞”。**只提示，不退出** |

### 设计约束

- **不内置、不改动上游两个项目**：只下载它们的 release 产物并校验 sha256。
- **不设硬编码超时**：卡住与否由「疑似停滞」提示交给模型/用户判断。
- **绝不自动删除用户文件**：半成品目录只报告，不清理。
- **串行下载**：一次只跑一个 amdl 进程（它自己在文件内分段并发）。
- **引擎无窗口启动**：Windows 上带 `windowsHide`，下载期间不会弹出前台终端。
- **零 npm 运行时依赖**。
- `data.img`（账号登录态）不会被 `fetch-engine` 覆盖 —— 重装引擎时会先挪开再放回。

### 已知限制

- 只支持 Windows
- 换籍的「成功」分支、AAC 降级、跨区 key500 只有构造样本，没有真实歌单覆盖
- 锁身份只用 pid，同进程内并发调用 `amdl_setup` 不互斥
- 会话关闭会取消 job 并停掉自己拉起的引擎；复用的他人引擎不会被停
- C/D 档复核只解决“账号区有没有”，不等于“一定能下”；复核产物永不自动下载

### 开发

> 单元测试与内部设计文档**不随仓库发布**（作者本地保留）。下面的分层规则仍然适用于改动代码。

分层规则（测试要在纯 Node 下能跑，所以逻辑必须与宿主解耦）：

- `lib/*.js` —— 纯逻辑，只能 import `node:*` 与同目录 `lib/`
- `tools/*.js` —— 薄接线，`import { defineTool } from '@deepseek-ai/dsh-tools'`
- `lib/config-schema.js` —— 唯一允许 import 宿主包的 lib 文件，**不得被测试 import**

---

## English

### Three tools

| Tool | What it does |
|---|---|
| `amdl_setup` | Fetch and verify the two dependencies (`plan` / `fetch-amdl` / `fetch-engine` / `verify`) |
| `amdl_match` | NetEase playlist → cross-region search → account-region re-resolution → downloadable list; C/D tiers get a separate account-region review (`pl-review-account.md`, never auto-downloaded) |
| `amdl_download` | Download a list or direct links serially; verify only this run's files and report audio quality |

### Requirements

- **Windows** (v1 is Windows-only; Linux/macOS untested)
- Node.js ≥ 22
- About 800 MB free disk (640 MB extracted engine + 157 MB kept zip)
- An Apple Music subscription (decryption needs an account session)

### Install

The plugin ships as a **bundle** into a DSH profile:

```
plugin_manager → install_bundle
target = https://github.com/Aiasti/dsh-amdl-suite
```

Restart DSH afterwards; the three tools appear on the model side.

To install your local build:

```powershell
npm pack --pack-destination dist
# then install_bundle target = <repo>\dist\dsh-amdl-suite-1.0.2.tgz
```

> Do **not** install with `link:`: the real path lives outside the profile, the host resolver cannot see `@deepseek-ai/*`, and the plugin fails to load. Do not put the bundle in a subdirectory either: DSH reads `dsh.bundle.patch` from the repository root.

### Usage

```
amdl_setup({ action: "plan" })          # see what is missing and where artifacts land
amdl_setup({ action: "fetch-amdl" })    # ~15 MB
amdl_setup({ action: "fetch-engine" })  # ~158 MB, 640 MB extracted
amdl_setup({ action: "verify" })        # 5/5 means ready
```

```
amdl_match({ playlistUrl: "https://music.163.com/#/playlist?id=..." })
# → { jobId, workDir }; poll with job_output
#   artifacts: pl-match-report.json / pl-download-cn.json / pl-cn-report.md / pl-review-account.md …

amdl_download({ workDir: "<workDir from the step above>" })   # playlist mode
amdl_download({ urls: ["https://music.apple.com/cn/album/x/1?i=2"] })  # direct mode
```

The two modes are **mutually exclusive**. Album/artist links expand to many tracks, so one “URL” may mean a whole record.

### Login (once)

Decryption keys come from the Apple Music app running inside wrapper-lite, so log in once before first use:

```powershell
%LOCALAPPDATA%\dsh-amdl-suite\engine\wrapper-lite-qemu\wrapper-lite-qemu.exe --login <appleid>:<password>
```

The session is persisted in `data.img`. The plugin **never touches your password**; it only checks whether `/status` returns a non-empty `regions` list and tells you what to do.

> If login fails with `SSL_ERROR_SYSCALL in connection to auth.itunes.apple.com`, a local proxy (TUN + fake-IP) is routing that domain incorrectly. Disable the proxy and use a direct connection.

### Where files go

Default state directory:

- Windows: `%LOCALAPPDATA%\dsh-amdl-suite\`
- Linux: `$XDG_DATA_HOME/dsh-amdl-suite/` (untested)

```
dsh-amdl-suite/
├── bin/amdl.exe
├── engine/wrapper-lite-qemu/     # engine artifacts (qemu/data.img holds the login)
├── engine/wrapper-lite-qemu.zip  # kept artifact
├── config/amdl.yaml              # rewritten each run (full template)
├── state/account.json            # last known account storefront
├── work/<playlistId>/            # match artifacts + account review
└── output/                       # downloaded music
```

### Configuration

Set these in the DSH plugin config (all optional):

| Key | Default | Meaning |
|---|---|---|
| `engineDir` | empty | Your own engine directory; must look like `<root>/engine/wrapper-lite-qemu` |
| `amdlPath` | empty | Your own amdl executable |
| `storefronts` | `jp,cn,hk` | Search regions |
| `accountStorefront` | empty | Account region for the C/D review; empty = auto-detect |
| `outputDir` | empty | Download destination |
| `alacMax` | `192000` | Quality ceiling |
| `engineRunId` / `engineSha256` | pinned CI run | Change both when upgrading the engine |
| `stagnationSeconds` | `60` | Idle time before a “possibly stalled” hint. **Hint only, never exits** |

### Design constraints

- **Neither bundled nor modified upstream**: only release artifacts, verified by sha256.
- **No hard-coded timeouts**: stall hints go to the model/user, who decides.
- **Never delete user files**: partial leftovers are reported, not cleaned.
- **Serial downloads**: one amdl process at a time (it parallelizes inside a file).
- **Windowless engine**: `windowsHide` on Windows, so no foreground console pops up during a download.
- **Zero npm runtime dependencies**.
- `data.img` (the account session) is preserved across `fetch-engine` reinstalls.

### Known limitations

- Windows only
- The “re-resolution success” branch, AAC fallback and cross-region key500 are covered by constructed samples only, not a real playlist
- Lock identity is pid-only; concurrent `amdl_setup` calls in the same process are not mutually exclusive
- Closing the session cancels the job and stops an engine this plugin started; an engine reused from elsewhere is left running
- The C/D review only answers “does the account region have it”; it never auto-downloads

### Development

> Unit tests and internal design docs are **not published** (kept locally by the author). The layering rules below still apply.

- `lib/*.js` — pure logic; may import `node:*` and sibling `lib/` only
- `tools/*.js` — thin wiring with `defineTool` from `@deepseek-ai/dsh-tools`
- `lib/config-schema.js` — the only lib file allowed to import a host package; **must not be imported by tests**

## License

MIT. See [LICENSE](LICENSE). The two upstream projects used at runtime are MIT too. The matching/fetch scripts under `vendor/` are original work and are licensed with this repository.

