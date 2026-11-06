# DSH Web 客户端设计语言观察（WakeDream UI v2 的参照）

> 参照物：本机正在运行的 DSH Web GUI（`http://127.0.0.1:62809`，Electron 桌面端内置的 Web 客户端）
> 与随包发布的 `@deepseek-ai/dsh-web-frontend` / `@deepseek-ai/dsh-client-ui-theme` 前端产物。
>
> **取证方式（可复现）**：运行中的 GUI 需要认证（直接请求返回 `401 dsh web authentication required`），
> 因此设计语言不是靠肉眼截图反推，而是从随应用打包的前端 bundle 里读出来的：
> 用零依赖的 ASAR 读取器取出
> `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/*.css`、
> `dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`（token 样式表）与
> `@deepseek-ai/dsh-client-ui-theme/README.zh.md`（主题/字号/材质规范）。
> 真实渲染图见 `deliverables/screenshots-v2/dsh-reference/`（把该 bundle 本地静态托管后截图，
> 它渲染的是 DSH 自己的首屏外壳，正文提示 `window.__ModuleLoader__ bootstrap facade is missing`，
> 说明数据层需要服务端注入，但**颜色与字号是真实的 DSH token**）。
>
> 本文只记录**设计语言**（尺度、层级、材质、交互约定），不复制其品牌文案、产品内容或私有数据。

## 1. 一句话结论

DSH 的克制来自三件事：**单色品牌**（主按钮是近黑/近白，不是彩色）、**中性偏冷的灰阶阶梯**
（`neutral-bluish` 斜坡，从 `#f9fafb` 到 `#151517`）、**层级靠材质与发丝线而不是阴影和边框**。
彩色只承担语义：业务蓝（DeepSeek 蓝）、成功绿、警告琥珀、错误红、完成紫。

## 2. 颜色：三层结构（静态 → 别名 → 专用）

### 2.1 静态色阶（`--dsw-static-*`，两套模式共用）

| 色族 | 关键档位 |
|---|---|
| `neutral-bluish`（主灰阶） | `00 #fff` · `50 #f9fafb` · `75 #f1f3f5` · `100 #ebeef2` · `200 #e1e5ee` · `300 #cfd3d6` · `400 #adb2b8` · `500 #979da6` · `600 #81858c` · `700 #61666b` · `750 #43454a` · `800 #353638` · `850 #2c2c2e` · `875 #232324` · `900 #1b1b1c` · `950 #151517` · `1000 #0f1115` |
| `neutral`（中性灰） | `50 #fafafa` … `900 #0f0f0f` |
| `deepseek`（业务蓝） | `50 #edf3fe` · `100 #e4edfd` · `200 #d3e2ff` · `400 #7aaaff` · `450 #5686fe` · `500 #4176e6` · `800 #34415b` · `900 #283142` |
| `blue / green / red / amber / violet` | blue `500 #3b82f6`；green `400 #4ed17e`·`500 #22c55e`；red `400 #f25a5a`·`600 #ec1313`；amber `400 #f7ad31`·`500 #f59e0b`；violet `400 #a78bfa`·`600 #7c3aed` |

### 2.2 别名（`--dsw-alias-*`，浅色 / 深色）

| 语义 | 浅色 | 深色 |
|---|---|---|
| `bg-base`（画布） | `#fff` | `#151517` |
| `bg-layer-1` | `#fff` | `#232324` |
| `bg-layer-2` | `#fff` | `#2c2c2e` |
| `bg-layer-3` | `#fff` | `#353638` |
| `label-primary` | `#0f1115` | `#f9fafb` |
| `label-secondary` | `#61666b` | `#cfd3d6` |
| `label-tertiary` | `#81858c` | `#adb2b8` |
| `border-l1 / l2 / l3` | `#0000000a` / `1a` / `1f` | `#ffffff0f` / `1f` / `29` |
| `brand-primary` | `#0f1115`（近黑） | `#f9fafb`（近白） |
| `state-success-primary` | `#22c55e` | `#22c55e` |
| `state-error-primary` | `#ec1313` | `#f25a5a` |
| `state-warn-primary` | `#f59e0b` | `#f59e0b` |
| `state-done-primary`（完成） | `violet-600 #7c3aed` | `violet-400 #a78bfa` |
| `state-business-primary`（业务/信息） | `deepseek-500 #4176e6` | `deepseek-400 #7aaaff` |

要点：**深色模式下 `bg-layer-1/2/3` 是逐级变亮的**（232324 → 2c2c2e → 353638），浅色模式下三层同为
白色，靠发丝线区分——即「深色靠亮度分层、浅色靠描边分层」。边框透明度全程不超过 16%。

### 2.3 专用层（`--dsw-specific-*`）

| token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `bubble` | `deepseek-50 #edf3fe` | `neutral-bluish-850 #2c2c2e` | **用户气泡**（截图里就是对侧浅蓝/深灰的气泡） |
| `bubble-highlight` | `deepseek-200 #d3e2ff` | `bluish-750 #43454a` | 气泡内引用/高亮 |
| `sidebar-fill` | `bluish-50 #f9fafb` | `bluish-900 #1b1b1c` | 侧栏底色（比画布略浅/略深） |
| `sidebar-nav-item-active` | `bluish-100` | `bluish-750` | 侧栏当前项填充 |
| `sidebar-nav-item-active-accent` | `deepseek-100` | `bluish-800` | 侧栏当前项强调填充 |
| `input-major` | `#fff` | `bluish-850` | 主输入框填充 |
| `selector` / `tip` | `bluish-60` | `bluish-800` | 选择器、提示面 |
| `menu` / `menu-surface-fill` | 70% 不透明 | 64% 不透明 + 背景模糊 | 菜单（浅色用 `border-l1`、深色用 `border-l3` 描边） |

按钮族：`button-primary-fill` = **brand-primary**（近黑/近白），hover 反相一档
（浅色 hover 用 `bluish-750`，深色 hover 用 `bluish-100`）；`button-info-fill` = DeepSeek 蓝（仅"信息/业务"语义）；
`button-elevated-fill` / `floating-fill` = 纯白或 `bluish-750/850`；ghost 激活态 = 填充 + `bluish-500/600` 描边。

## 3. 字体与字阶

字体：界面用**系统字体栈**（`--dsh-font-family-text-default`），等宽用
`"SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, "PingFang SC", "Microsoft YaHei"`；
品牌文字（HARNESS 字样）单独用随包字体 **Montserrat**（300/400/500），普通界面不出现。

字阶（`--dsw-font-*`，固定像素 + 固定行高）：

| 字号 | 行高 | 档位名 |
|---:|---:|---|
| 11 | 14 | `xxxs` |
| 12 | 18 | `xxs` |
| 13 | 20 | `xs` |
| 14 | 22 | `s` |
| 16 | 24 | `base` |
| 18 | 28 | `m` |
| 20 | 28 | `l` |
| 24 | 32 | `xl` |

会话正文不是死值，而是**用户可调**的一对变量：`--dsh-content-font-size`（默认 14，范围 10–22）
+ `--dsh-content-font-delta`；代码字号 `--dsh-code-font-size`（默认 11，范围 10–16）+ delta；
终端 13（10–20）。派生规则：

- Markdown 标题全部 **700 字重**，基准 h1 `21/30`、h2 `19/28`、h3 `18/26`，h4 回到正文大小 `14/24`；
- **流内的标题、摘要、表格用"低一档"字号**（`--dsh-content-font-size-secondary`：设置 ≤14 时 −1，>14 时 −2，默认 13），表格行高 22；
- **行内代码比代码字号大 1px**；工具输出的小号变体与代码字号相同；
- 紧凑的小号文本（标签、计数）**不随字号设置变化**；
- 正文行高 24（1.71），代码行高 19。

## 4. 间距、圆角、发丝线

- **间距刻度**：4 / 6 / 8 / 10 / 12 / 16（统计上 8 最多，4 与 12 次之），没有 20/24 的常驻间距；
  典型内边距 `padding:10px 16px`（气泡）、`9px 14px`（按钮）、`6px 8px`（紧凑标签）。
- **圆角刻度**：`xs 4` / `sm 8` / `md 12` / `lg 16` / `xl 20` / `panel 28`。
  实际用量：**8 最多**（控件、菜单项、标签），12（卡片、面板），16（大面板），4（小块），
  `999px` 全胶囊很少用（4 处），气泡用 `xl 20`。
- **发丝线**：`--dsh-hairline-width` 由 DPR 计算 = `0.5px` 向下取整到整物理像素（最小 1 物理像素），
  只有显式引用该变量的样式才用；高层级表面（菜单/浮层/对话框）**不设 border，改用
  `--dsw-elevation-stroke` 画 0.5px 描边 + 两层极淡柔光**，避免轮廓占布局。
- **圆角平滑**：支持 `corner-shape: superellipse(1.5)` 的引擎给所有元素做超椭圆平滑；
  正圆/胶囊必须显式 `corner-shape: round` 以免被平滑变形。

## 5. 阴影与层级

| token | 值 |
|---|---|
| `shadow-lv1` | `0 2px 4px 0 #0000000d` |
| `shadow-lv1-blur` | `0 4px 12px 0 #00000005` |
| `shadow-lv2` | `0 4px 12px 0 #00000005, 0 2px 8px 0 #0000000a` |
| `shadow-lv3` | `0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014` |

阴影极淡；常驻界面基本不用阴影，弹层才用 lv3。模态遮罩是**黑色半透明、不做背景模糊**；
菜单相反：**半透明填充 + 背景模糊**。

## 6. 交互与无障碍约定

- **焦点环**：颜色 = business-primary 蓝，浅色 `#4176E6`、深色 `#7AAAFF`，宽度 2px；
  **指针模态下焦点环透明**（`html[data-input-modality=pointer] body :focus-visible:not(:read-write)`），
  即只有键盘操作时才画环；可编辑文本控件点击时保留自身反馈。密集表格/工具栏允许 1px。
- **动效**：100–180ms，`ease` / `ease-out`；弹层用 `opacity .14s ease-out, transform .18s cubic-bezier(.22,1,.36,1)`；
  没有弹簧、没有长动画；`prefers-reduced-motion` 下停用旋转类动画。
- **滚动条**：WebKit 伪元素宽度 5px、thumb 绑定 l1 表面（高层级表面重绑定为 l2，指针不在栏内时可为
  `transparent`），可见滑块外保留更宽的拖动区；Firefox 走标准细滚动条。
- **状态永远有语义色 + 文字**：`state-*` token 覆盖 success/warn/error/done/business/idle；
  开关滑块 token 保证关闭态滑块比轨道亮（深色用 `bluish-400` 而不是纯白，避免刺眼）。
- 主题按浏览器持久化（`ui-theme` 命名空间），并在**首帧之前**由内联脚本写入
  `body[data-ds-dark-theme]` 与字号变量，避免闪白/闪字号。

## 7. WakeDream v2 采纳了什么（逐条对应）

| 观察 | 本项目的落地 |
|---|---|
| 单色品牌：主按钮近黑/近白，不用彩色大按钮 | 主行动（现在做梦、保存计划、扫描）改为单色填充；彩色只留给状态与 agent 身份 |
| 中性偏冷灰阶 + 深色靠亮度分层、浅色靠描边分层 | 重写 `--bg/--layer-1/2/3/--line-1/2/3` 三层表面阶梯，深色逐级变亮、浅色同白靠发丝线 |
| 业务蓝只承担"信息/选中/焦点" | 选中行、当前导航、链接、焦点环统一用 DeepSeek 蓝族（浅 `#4176e6`、深 `#7aaaff`），不再用紫色大色块 |
| 字阶 11/12/13/14/16/18/20/24 + 固定行高 | 全站换成这套字阶；会话正文 14/24，标题 700 字重，行内代码 +1px |
| 间距 4/6/8/10/12/16、圆角 8/12/16/20 | 控件 8、卡片 12–16、气泡 20、面板 16；内边距统一到 4 的倍数 |
| 发丝线 ≤16% 透明、高层级不占布局 | 全部边框改用 `--line-1/2/3`；菜单/弹层用 0.5px 描边 + lv3 阴影 |
| 极淡阴影（4 档） | 常驻卡片几乎无阴影，仅弹层/浮层用 `--shadow-lv2/3` |
| 指针模态不画焦点环 | `:focus-visible` 只在键盘下出现，焦点色用业务蓝 |
| 动效 100–180ms、ease-out、弹层 cubic-bezier(.22,1,.36,1) | 统一交互过渡时长与曲线，并加 `prefers-reduced-motion` 开关 |
| 滚动条 5px、按层级重绑定 | 滚动条改 6px 半透明 thumb，悬停加深，指针移出时更淡 |
| 首帧前应用主题，避免闪烁 | 保留并强化 boot 期主题注入（`?theme=` 覆盖 + localStorage） |
| 空态：居中图标 + 标题 + 一句说明 + 一个动作 | 空态/错误态重排为同一形制，图标用 40px 圆形柔光底 |
| 用户气泡 vs 助手平铺 | 气泡规格照搬（`xl` 圆角、`10px 16px` 内边距、业务蓝浅底/深灰底），助手保持平铺 + 24px 行高 |

**没有采纳**：DSH 的 Montserrat 品牌字体与 "HARNESS" 字样（我们的品牌是自己画的月牙标记 + 系统字体，
且本项目硬约束禁止外链字体）；DSH 的产品文案、图标资产、会话内容；它的多插件设置页结构
（我们的信息架构由 `docs/ARCHITECTURE.md` 冻结，六页不变）。
