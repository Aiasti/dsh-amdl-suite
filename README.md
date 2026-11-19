# dsh-amdl-suite

English | [简体中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) host plugin that aligns NetEase Cloud Music playlists or Apple Music links with your local library and prepares ALAC files. No web UI — everything runs through model-side tools.

The plugin appears in DSH as **amdl套件 / amdl Suite**. It reuses two open-source projects **without bundling or modifying them**, downloading only their official release artifacts:

| Project | Role |
|---|---|
| [zhaarey/apple-music-downloader](https://github.com/zhaarey/apple-music-downloader) (amdl) | Download and decryption |
| [WorldObservationLog/wrapper](https://github.com/WorldObservationLog/wrapper/tree/lite) (wrapper-lite) | `/key` decryption service (the Apple Music app inside QEMU) |

## Three tools

| Tool | What it does |
|---|---|
| `amdl_setup` | Fetch and verify the two dependencies (`plan` / `fetch-amdl` / `fetch-engine` / `verify`) |
| `amdl_match` | NetEase playlist → cross-region search → account-region re-resolution → downloadable list; C/D tiers get a separate account-region review (`pl-review-account.md`, never auto-downloaded) |
| `amdl_download` | Download a list or direct links serially; verify only this run's files and report audio quality |

## Requirements

- **Windows** (v1 is Windows-only; Linux/macOS untested)
- Node.js ≥ 22
- About 800 MB free disk (640 MB extracted engine + 157 MB kept zip)
- An Apple Music subscription (decryption needs an account session)

## Install

The plugin ships as a **bundle** into a DSH profile:

```
plugin_manager → install_bundle
target = https://github.com/Aiasti/dsh-amdl-suite
```

Restart DSH afterwards; the three tools appear on the model side.

To install your local build:

```powershell
npm pack --pack-destination dist
# then install_bundle target = <repo>\dist\dsh-amdl-suite-1.0.3.tgz
```

> Do **not** install with `link:`: the real path lives outside the profile, the host resolver cannot see `@deepseek-ai/*`, and the plugin fails to load. Do not put the bundle in a subdirectory either: DSH reads `dsh.bundle.patch` from the repository root.

## Usage

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

## Login (once)

Decryption keys come from the Apple Music app running inside wrapper-lite, so log in once before first use:

```powershell
%LOCALAPPDATA%\dsh-amdl-suite\engine\wrapper-lite-qemu\wrapper-lite-qemu.exe --login <appleid>:<password>
```

The session is persisted in `data.img`. The plugin **never touches your password**; it only checks whether `/status` returns a non-empty `regions` list and tells you what to do.

> If login fails with `SSL_ERROR_SYSCALL in connection to auth.itunes.apple.com`, a local proxy (TUN + fake-IP) is routing that domain incorrectly. Disable the proxy and use a direct connection.

## Where files go

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

## Configuration

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

## Design constraints

- **Neither bundled nor modified upstream**: only release artifacts, verified by sha256.
- **No hard-coded timeouts**: stall hints go to the model/user, who decides.
- **Never delete user files**: partial leftovers are reported, not cleaned.
- **Serial downloads**: one amdl process at a time (it parallelizes inside a file).
- **Windowless engine**: on Windows the launcher runs in a hidden console that QEMU inherits; no foreground window appears during a download.
- **Zero npm runtime dependencies**.
- `data.img` (the account session) is preserved across `fetch-engine` reinstalls.

## Known limitations

- Windows only
- The “re-resolution success” branch, AAC fallback and cross-region key500 are covered by constructed samples only, not a real playlist
- Lock identity is pid-only; concurrent `amdl_setup` calls in the same process are not mutually exclusive
- Closing the session cancels the job and stops an engine this plugin started; an engine reused from elsewhere is left running
- The C/D review only answers “does the account region have it”; it never auto-downloads

## Development

> Unit tests and internal design docs are **not published** (kept locally by the author). The layering rules below still apply.

- `lib/*.js` — pure logic; may import `node:*` and sibling `lib/` only
- `tools/*.js` — thin wiring with `defineTool` from `@deepseek-ai/dsh-tools`
- `lib/config-schema.js` — the only lib file allowed to import a host package; **must not be imported by tests**

## License

MIT. See [LICENSE](LICENSE). The two upstream projects used at runtime are MIT too. The matching/fetch scripts under `vendor/` are original work and are licensed with this repository.

