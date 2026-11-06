# WakeDream 桌面客户端（Tauri v2 + Node 边车）

把 `app/` 里那套「Node 零依赖本地服务 + 手写 ESM Web UI」原样装进一个多平台桌面应用。**不用 Electron**：
外壳是 Tauri v2（系统 WebView，macOS 上是 WKWebView），业务逻辑一个字节都没重写——它跑在**边车**里，
也就是一个把 `app/src/**` 打成一个自包含可执行文件的 **Node SEA（Single Executable Application）**。

```
WakeDream.app/
  Contents/MacOS/
    wakedream-desktop          ← Tauri 壳（Rust，约 6 MiB）：选端口 → 拉边车 → 等就绪 → 开窗
    wakedream-server           ← 边车（Node SEA，约 127 MiB）：就是 app/src/server/main.js 那一套
  Contents/Resources/
    web/                       ← 六页 Web UI（bundle.resources，运行期用 WAKEDREAM_WEB_DIR 告诉边车）
    icon.icns
```

为什么是「壳 + 边车」而不是把 Node 嵌进 Rust 进程：

- `app/src/**` 是冻结契约、零运行时依赖、纯 ESM；SEA 能把它原样打包，不需要为桌面端重写一遍；
- 用户机器上**不需要装 Node**（边车自带一份 Node 运行时）；
- 壳只负责窗口与进程生命周期，出问题时「服务」这一层还能单独用 `node src/server/main.js` 跑，排障面小。

## 1. 前置依赖

| 用途 | 依赖 | 本机实测版本 |
|---|---|---|
| 边车打包 | Node.js ≥ 22.5（要 `node --experimental-sea-config`） | v25.7.0 |
| 边车打包 | npm（装构建期依赖） | 11.10.1 |
| 壳编译 | Rust stable（rustup，`rustc`/`cargo`） | rustc 1.98.1 / cargo 1.98.1 |
| 壳编译 | Xcode Command Line Tools（macOS）/ MSVC Build Tools（Windows）/ webkit2gtk 等（Linux） | Apple clang 17 |
| 打包 | `@tauri-apps/cli` v2（**用 npm 预编译包，不要 `cargo install tauri-cli`**，后者要现场编译十几分钟） | tauri-cli 2.12.4 |
| 边车打包 | `esbuild`、`postject` | 0.25.12 / 1.0.0-alpha.6 |

```bash
# 一次性准备
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
source "$HOME/.cargo/env"
cd app/desktop && npm install          # 只装构建期依赖，落在 app/desktop/node_modules
```

> `app/desktop/node_modules` 是**构建期**依赖（Tauri CLI / esbuild / postject），
> `app/package.json` 保持零依赖不变；运行时同样零依赖。

## 2. 打边车（三平台通用）

```bash
cd app
node scripts/build-sidecar.mjs --target <target-triple>
```

产物：`app/src-tauri/binaries/wakedream-server-<target-triple>[.exe]`（Tauri 边车命名约定，`externalBin` 直接找这个名字）。

脚本做的事（`--no-verify` 可跳过最后一步，`--keep-work` 保留中间产物）：

1. **esbuild** 把 `src/**` 打成单个 CJS 文件（Node 内置模块外置）；三处「打包不友好」的写法在这里被改写，
   而且每处都带硬断言，源码换了形状就报错，不会静默产出坏二进制：
   - `src/server/main.js` 里 `await import(spec)` 是**变量** specifier，esbuild 静态分析不到 → 8 个 api 模块会一个都进不了包
     （实测：不改写时包 150 KiB 且 `emitEvent` 等 api 代码整段缺失；改写后 309 KiB、8 个模块齐全）。构建期把它换成静态映射表。
   - `src/server/api/scan.js` 里 `await import('./events.js')` 是**可选**依赖（文件还不存在）→ esbuild 会直接报错。
     构建期给解析不到的相对依赖注入一个「import 时才抛 `ERR_MODULE_NOT_FOUND`」的占位模块，语义与 ESM 一致。
   - `src/server/dream/prompts/index.js` 运行期 `readFileSync` 本目录的 `*.md`——二进制里没有这些文件。
     构建期把 6 份提示词**内联**进包。
   - 另外 `import.meta.url` 在 CJS 下为空，用 esbuild `define` 换成一个钉死的 bundle URL（**不能**用可执行文件自身的
     URL：SEA 里 `__filename` 与 `process.argv[1]` 都是可执行文件路径，那样 `main.js` 的 `isMain` 会判真 → 壳与
     `main.js` 各启动一次 → 同进程双实例抢端口，表现为启动即 `EADDRINUSE` 崩溃。这个坑真踩过，已在代码里注释）。
2. `node --experimental-sea-config` 生成 blob（`useSnapshot: false` / `useCodeCache: false`）。
3. 复制一份当前 `node` 可执行文件，用 **postject** 把 blob 注入（macOS 要 `--macho-segment-name NODE_SEA`）。
4. **签名**：注入会破坏 node 原有的 ad-hoc 签名，macOS 上必须 `codesign --remove-signature` + `codesign -s -` 重签，
   否则内核直接拒绝执行。
5. **冒烟自检**（默认开）：真的把二进制跑起来（临时 `WAKEDREAM_HOME` + 空闲端口），断言
   `/api/health` 返回 `ok:true`、`/` 能从 `WAKEDREAM_WEB_DIR` 取到 index.html、`/api/sessions` 能返回
   （证明 8 个 api 模块真在包里）、二进制里能搜到内联提示词。任何一条不过就**构建失败**。

实测（macOS arm64）：边车 126.4 MiB，构建 7.1 秒，4 项自检全过；构建报告落在 `app/desktop/build-report.json`。

## 3. 打桌面端

```bash
cd app
./desktop/node_modules/.bin/tauri build                 # 全量：.app + .dmg（macOS）
./desktop/node_modules/.bin/tauri build --bundles app   # 只要 .app（CI 排障时快）
./desktop/build-dmg.sh                                  # 只要 .dmg（不依赖 Finder 自动化，见 §5）
./desktop/node_modules/.bin/tauri dev                   # 开发态：没边车二进制就退回系统 node 跑 src/server/main.js
```

产物位置（`app/src-tauri/target/release/bundle/`）：

| 平台 | 目标 | 产物 |
|---|---|---|
| macOS | `app` | `bundle/macos/WakeDream.app`（132.9 MiB） |
| macOS | `dmg` | `bundle/dmg/WakeDream_0.1.0_aarch64.dmg`（Tauri 自带的 dmg 步骤）<br>或 `bundle/dmg/WakeDream_0.1.0_aarch64-apple-darwin.dmg`（用 `./desktop/build-dmg.sh` 出，47 MiB） |
| Windows | `nsis` | `bundle/nsis/WakeDream_0.1.0_x64-setup.exe`（NSIS 安装包） |
| Windows | `msi` | `bundle/msi/WakeDream_0.1.0_x64_en-US.msi`（MSI 安装包） |
| Linux | `deb` | `bundle/deb/WakeDream_0.1.0_amd64.deb` |
| Linux | `appimage` | `bundle/appimage/WakeDream_0.1.0_amd64.AppImage` |

各平台 `--target`：

```bash
# macOS arm64（本机真机验证过的就是这条）
node scripts/build-sidecar.mjs --target aarch64-apple-darwin
./desktop/node_modules/.bin/tauri build --target aarch64-apple-darwin --bundles app,dmg
# macOS x64
node scripts/build-sidecar.mjs --target x86_64-apple-darwin
./desktop/node_modules/.bin/tauri build --target x86_64-apple-darwin --bundles app,dmg
# Windows（在 Windows 上跑；边车要用 Windows 的 node.exe 打）
node scripts\build-sidecar.mjs --target x86_64-pc-windows-msvc
npx tauri build --target x86_64-pc-windows-msvc --bundles nsis,msi
# Linux（x86_64）
node scripts/build-sidecar.mjs --target x86_64-unknown-linux-gnu
npx tauri build --target x86_64-unknown-linux-gnu --bundles deb,appimage
```

Linux 需要先装：`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev`。
Windows 需要 MSVC Build Tools + WebView2 Runtime（Win10 1803+ 自带）。

### 本机实测计时

| 步骤 | 命令 | 耗时 |
|---|---|---|
| 依赖检查（首次，dev profile，含全部依赖编译） | `cargo check` | 31.4s |
| **冷编译全量 release + 打 .app**（`cargo clean` 之后，6161 个文件 / 1.9 GiB） | `tauri build --bundles app` | **59.9s**（real）／5m07s（CPU） |
| 壳编译 + 打 .app（增量，改了 main.rs 之后） | `tauri build --bundles app` | 15.4s |
| 打 .dmg | `./desktop/build-dmg.sh` | 约 10s（含挂载自检） |

（本机是 Apple Silicon 多核，CPU 时间是 wall time 的 5 倍，说明并行度很高；CI 上第一次会明显更久。）

## 4. 运行期行为

1. **选端口**：默认 `4680`；被占用就向内核要一个空闲端口。
2. **拉起边车**：先自己判断「可执行文件旁边的 `wakedream-server` 在不在」，在就用 `tauri-plugin-shell`
   的 sidecar 能力拉起；不在就退回系统 `node` 跑 `app/desktop/sidecar-entry.js`（开发态 / `tauri dev` 走这条）。
   环境变量 `PORT`、`WAKEDREAM_WEB_DIR`（指向 `Contents/Resources/web`）、`WAKEDREAM_DESKTOP=1`；
   数据目录沿用 `~/.wakedream`（`WAKEDREAM_HOME` 可覆盖）。随即建一个「启动中」窗口（内嵌占位页），用户点开图标立刻有反应。

   > 为什么非要自己判断存在性：`shell.sidecar()` **只拼路径、不检查文件在不在**，缺文件时报错发生在后面的
   > `spawn()` 里——只看 `sidecar()` 的返回值根本回退不到 node。（这个坑真踩过：删掉 `Contents/MacOS/wakedream-server`
   > 之后，日志里是「拉起打包边车」紧接着「启动失败：No such file or directory」，`tauri dev` 首次体验就是打不开。）
   >
   > 为什么回退的是 `desktop/sidecar-entry.js` 而不是 `src/server/main.js`：前者带信号处理与「父进程被 reparent
   > 到 init 就自杀」的看门狗，后者没有——壳被强杀（`kill -9`）时直接跑 `main.js` 会留下占着端口的孤儿 node。
   > 现在开发态与打包态用的是同一个入口，行为一致。
3. **等就绪**：轮询 `GET http://127.0.0.1:<port>/api/health`（手写的最小 HTTP/1.1，省一个 http 客户端依赖），
   最多 30 秒；任一次拿到 `{"ok":true}` 就把窗口 `navigate` 到客户端地址并把标题改成 `WakeDream`。
4. **失败不装死**：超时或边车刚起来就退出 → 标题写明原因，并通过 `eval` 把完整错误送进占位页显示；
   日志写 `~/.wakedream/logs/desktop.log`。
5. **退出收尸**：窗口关闭 / Cmd+Q / 菜单退出 → 显式 `kill` 边车；另有 `kill_on_drop(true)` 与边车自己的
   「父进程被 reparent 到 init 就自杀」看门狗两层兜底，**不会留下孤儿进程**；强杀壳的情况下边车不是立刻消失，而是在**一个看门狗周期内（最长约 5s）**自退（独立验证实测 2581ms / 2586ms 两次，端口随后释放）。
6. **外链**：`on_navigation` 只放行内嵌占位页与「本轮真正选中的那个端口」，其余（外链、`mailto:`、别的本地服务）
   一律交给系统默认程序，不在应用窗口里打开。
7. **菜单**：WakeDream（关于 / **打开数据目录** / **在浏览器中打开** / 服务 / 隐藏 / 退出）、编辑（撤销重做剪切复制粘贴全选）、
   窗口（最小化 / 关闭 / 全屏）。
8. **权限从紧**：网页（`http://127.0.0.1:*`）不调用任何 Tauri IPC，能力清单只给 `core:default`；
   `shell` / `opener` 只在 Rust 侧使用，不下放给网页。

## 5. 签名、公证与「打开被拦」

本仓库**没有** Apple 开发者证书，走 **ad-hoc 签名**（`tauri.conf.json` 里 `bundle.macOS.signingIdentity: "-"`）：

- `codesign --verify --deep --strict` 通过（`valid on disk` / `satisfies its Designated Requirement`）；
- `spctl -a -t exec` **会被拒**（`rejected`）——Gatekeeper 不认 ad-hoc 签名，这是预期行为，不是构建坏了。

用户侧影响与做法：从网上下载（带 quarantine 属性）的 `.dmg` 打开后，需要**右键 →「打开」**（或
「系统设置 → 隐私与安全性 → 仍要打开」）；本地自己构建的产物没有 quarantine 属性，直接双击即可。

正式发版要换成真证书 + 公证（`APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`
或 `APPLE_API_KEY*`，Tauri 会自动做 codesign + notarize + staple）。

### macOS 上 `tauri build` 的 dmg 步骤需要「自动化」权限

`tauri build` 的 dmg 步骤会调用 create-dmg，其中用 `osascript` 驱动 Finder 摆放图标位置。
**在没有 Finder 自动化权限的环境里（本机就是这样）这一步会一直挂住**，表现为 `bundle/target/.../dmg/bundle_dmg.sh`
停着不动、`.app` 早已生成但命令不返回。绕法（本机实测可用，产物功能完全正常，只是没有自定义图标位置）：

```bash
cd app/src-tauri/target/release/bundle/macos
../dmg/bundle_dmg.sh --volname WakeDream --icon WakeDream.app 180 170 \
  --app-drop-link 480 170 --window-size 660 400 --hide-extension WakeDream.app \
  --volicon ../dmg/icon.icns --skip-jenkins \
  WakeDream_0.1.0_aarch64.dmg WakeDream.app
```

`--skip-jenkins` 就是 create-dmg 提供的「跳过 Finder AppleScript」开关。CI 上（无 GUI 会话）同理。
只想验证壳本身时用 `tauri build --bundles app` 即可，不受影响。

本仓库另有一个**不依赖 Finder 自动化**的等价脚本（本机最终产物就是它出的，且自带挂载自检）：

```bash
cd app && ./desktop/build-dmg.sh
# → src-tauri/target/release/bundle/dmg/WakeDream_<版本>_<triple>.dmg
#   卷名 WakeDream，内含 WakeDream.app + Applications 软链 + 卷图标
```

它用 `hdiutil create -format UDZO` 直接出包，与 Tauri 那版的唯一差别是没有「图标坐标美化」。

## 6. CI：三平台打包 / 发版

`.github/workflows/desktop.yml`：矩阵 macOS arm64（`macos-14`）、macOS x64（`macos-13`）、
Windows（`windows-latest`）、Linux（`ubuntu-22.04`）；每条腿先装 Node + Rust + 系统依赖，
再 `node scripts/build-sidecar.mjs --target <triple>` 打边车（macOS 上额外 ad-hoc 重签），
跑 `node --test test/desktop.test.js`，最后用 `tauri-apps/tauri-action` 出包。
手动触发只上传构建产物；推 `v*` tag 则创建 draft Release。

## 7. 验证到什么程度（如实说）

| 项目 | 状态 |
|---|---|
| macOS arm64 真机构建（`.app` + `.dmg`） | ✅ 真跑通 |
| macOS arm64 真机启动 + 边车拉起 + 窗口加载今日页 | ✅ 真跑通（进程/端口/连接/访问日志四重证据，见下） |
| 退出后不留孤儿边车 | ✅ 三条路径都验证过（优雅退出 / 强杀壳 / 开发态 node 回退 + 强杀壳） |
| 启动失败时的提示窗 | ✅ 真跑过：删掉边车二进制并把 `WAKEDREAM_NODE` 指到不存在的路径 → 日志出「启动失败：拉起边车失败：No such file or directory (os error 2)」，壳进程不崩、停在提示页 |
| 端口被占用时换端口 | ✅ 真跑过：4680 被占时选中 51803，窗口照常加载 |
| 开发态 `tauri dev` 回退（无边车二进制 → 系统 node） | ✅ 真跑过：日志出「没有可用的边车二进制（… 不存在），回退系统 node：node …/desktop/sidecar-entry.js」，随后 `/api/health` 正常 |
| `tauri dev` 本体（带界面长时间开发） | ⚠️ 未跑完整流程：只验证了它的回退分支（逻辑与实际命令），没有真的开着 dev 窗口改代码 |
| Windows / Linux 构建 | ❌ **未真机验证**：只写了配置与 CI 矩阵，没有在这些系统上跑过 |
| macOS 公证 / 真证书签名 | ❌ 未做（无证书，ad-hoc） |
| 自动更新（updater） | ❌ 未做（未配置签名密钥与更新端点） |
| 系统截图作为窗口证据 | ❌ **受限**：本机没有「屏幕录制」权限，`screencapture` 只能拍到壁纸；「辅助功能」权限也没授予，`osascript` 查窗口标题会挂住。因此改用进程树 / 端口 / socket 属主 / 边车访问日志作为证据 |

### 启动验证的原始证据（macOS arm64）

```
# 1) 打包后的应用被 open 起来，边车是它的直接子进程
  PID  PPID COMMAND
 9224     1 /…/WakeDream.app/Contents/MacOS/wakedream-desktop
 9242  9224 wakedream-server

# 2) 边车在监听默认端口
COMMAND    PID USER   FD   TYPE  NAME
wakedream 9242 user 22u  IPv4  TCP 127.0.0.1:4680 (LISTEN)

# 3) 窗口（WebKit）真的在跟边车说话：网络进程持有 5 条 ESTABLISHED
com.apple 9239 … TCP 127.0.0.1:51285->127.0.0.1:4680 (ESTABLISHED)
com.apple 9239 … TCP 127.0.0.1:51287->127.0.0.1:4680 (ESTABLISHED)
com.apple 9239 … TCP 127.0.0.1:51288->127.0.0.1:4680 (ESTABLISHED)
wakedream 9242 … TCP 127.0.0.1:4680->127.0.0.1:51285 (ESTABLISHED)
…（9239 = com.apple.WebKit.Networking.xpc，即这个窗口的 HTTP 客户端）

# 4) 健康检查（真实数据目录）
{"ok":true,"app":"WakeDream","version":"0.1.0","home":"$HOME/.wakedream",
 "lastScanAt":1793939010483,"lastDreamAt":1793939014456,"lan":{"enabled":false,"deviceName":"<device>"}}

# 5) ~/.wakedream/logs/desktop.log：窗口加载的是「今日」页
[desktop] 端口：4680（默认 4680）
[desktop] web 资源目录：/…/WakeDream.app/Contents/Resources/web
[desktop] 拉起打包边车：wakedream-server
[sidecar] WakeDream v0.1.0 已启动：http://127.0.0.1:4680 （数据目录 $HOME/.wakedream）
[sidecar] api 模块：已加载 8 个
[desktop] 边车就绪（255 ms）：http://127.0.0.1:4680/
[server] GET / 200 · /styles.css 200 · /app.js 200 · /assets/contract.js 200 · /assets/api.js 200 ·
         /assets/icons.js 200 · /assets/format.js 200 · /assets/ui.js 200 ·
         /views/today.js 200 · /views/common.js 200            ← 今日页模块
         /api/health 200 · /api/agents 200 · /api/settings 200 · /api/stats 200 · /api/sessions 200 · /api/dreams 200
         /api/events 404                                        ← SSE 端点尚未实现（契约里是可选，UI 已容错）

# 6) 退出回收（优雅退出路径）
[desktop] 应用退出，回收边车
[desktop] 边车已退出
[sidecar] 进程结束：TerminatedPayload { code: None, signal: Some(9) }
```

## 8. 图标

`app/desktop/icon-source.png`（1024×1024）由 `app/desktop/icon-gen.mjs` **用代码画**出来，
形状与 `app/web/index.html` 里的品牌标记同源（月亮落在地平线上），配色取 UI 令牌的
暖石墨底 + 暮紫 `#9b8cff`。没有 emoji、没有第三方品牌图、不依赖任何图形库（PNG 用内置 zlib 手写编码）。

```bash
node desktop/icon-gen.mjs                                  # 重新生成源图
./desktop/node_modules/.bin/tauri icon desktop/icon-source.png -o src-tauri/icons
```

> 踩坑记录：品牌标记是**描边**图形（`fill="none" stroke-width="1.6"`）。第一版按 SVG path 的**填充区域**去画，
> 得到一块又肥又糊的半月，与品牌标记根本不是一回事。现在按「把那条弧描粗」来画，才是同一个形状。

## 9. 目录

```
app/
  desktop/                  构建期工具与依赖（不进运行时）
    package.json            @tauri-apps/cli / esbuild / postject
    sidecar-entry.js        SEA 入口薄壳（调 src/server/main.js 的 start()）
    icon-gen.mjs            图标生成（可单测的几何函数 + 自写 PNG 编码）
    icon-source.png         1024×1024 图标源图
    build-dmg.sh            出 .dmg（hdiutil，不依赖 Finder 自动化；自带挂载自检）
  scripts/build-sidecar.mjs 边车构建（含三处构建期改写 + 冒烟自检）
  src-tauri/
    Cargo.toml build.rs tauri.conf.json
    src/main.rs             壳：选端口 / 拉边车 / 轮询 health / 建窗 / 菜单 / 收尸
    capabilities/default.json
    web-dist/index.html     启动中 & 启动失败占位页
    icons/                  tauri icon 生成的全套图标
    binaries/               ← 边车产物（git 忽略；构建时生成）
  test/desktop.test.js      21 条自检（配置 / 构建脚本 / 边车二进制 / Rust 壳静态契约 / CI / 文档）
```

## 10. 测试

```bash
cd app
node --test test/desktop.test.js            # 桌面端自检（21 条）
node --test "test/**/*.test.js"             # 全量
```

需要边车二进制 / 打包产物的 4 条用例在没有产物时会 **skip**（二进制不进 git，新克隆的仓库本来就没有），
构建之后（本地或 CI）都是硬断言。其余用例不依赖产物：其中「边车打包真跑一次」用 esbuild 在内存里
真打一次包、断言三处构建期改写真的生效（约 0.14 秒，不落盘、不做 SEA/注入/签名）。
