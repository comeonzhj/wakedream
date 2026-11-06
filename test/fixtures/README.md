# test/fixtures —— 合成测试数据

这里的文件**全部是合成数据**（假的会话 ID、假的路径、假的项目名），只用于解析器与扫描器的契约测试，不含任何真实用户的会话内容。

## 来源

| 目录 | 说明 |
|---|---|
| `claude/`、`codex/`、`cursor/`、`gemini/`、`kimi/`、`kiro/`、`qoder/`、`dsh/` | 由 [Wake](https://github.com/iAmCorey/Wake)（MIT，commit `3aabdc1d5ff903b4ef4de4e7fc21cfb39b52484c`）的测试 fixture 改写而来：这些样本由 Wake 作者构造，我们按同样的目录形状与字段语义复用来卡住各 agent 的解析行为；`dsh/` 另按 DeepSeek Harness 的真实事件格式补齐。 |
| `dsh-home/`、`ssh-home/` | 本项目自建：模拟「一个假的家目录」，用于验证扫描根解析与 SSH 镜像路径。 |
| `dream/` | 本项目自建：做梦引擎的输入（会话/消息行）、假 LLM 端点用的样本、真实数据入库脚本。 |

许可证与出处见仓库根目录 `THIRD_PARTY_NOTICES.md`。

## 约定

- 新增 fixture 只允许合成数据；**不要**把真实会话（哪怕删改标题）放进来。
- 目录层级要贴近各 agent 的真实布局，否则解析器契约测试会失真。
