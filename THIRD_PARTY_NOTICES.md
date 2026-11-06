# 第三方来源与致谢（THIRD-PARTY NOTICES）

本项目是独立实现，**没有包含任何上游项目的源码仓库**。以下仅为参考、语义对齐或测试数据来源，按各自的许可证使用。

## 1. Wake（https://github.com/iAmCorey/Wake，MIT）

- 用途：产品与信息架构参考（多 Agent 会话管理器的信息组织、`@host` 远程会话徽章、Remote hosts 的 SSH 白名单镜像思路）、会话数据源的路径与字段语义对齐。
- 本项目**不包含** Wake 的源码或其仓库快照；开发期使用的 Wake 浅克隆快照（commit `3aabdc1d5ff903b4ef4de4e7fc21cfb39b52484c`）位于开发机 `reference/Wake/`，**不在本仓库内**。
- 唯一派生内容：`test/fixtures/` 下部分**合成测试数据**（假的会话 JSONL/JSON，用于各 agent 解析器契约测试）由 Wake 的测试 fixture 改写而来，原始数据为 Wake 作者构造的合成样本，按 MIT 许可证使用，详见 `test/fixtures/README.md`。

## 2. DeepSeek Harness（DSH）

- 用途：本仓库由 DeepSeek Harness 的智能体开发与验证；界面设计语言参照其 Web 客户端（`web/docs/dsh-reference.md`（本仓库根目录即应用根） 记录了观察结论）。
- DSH 是开发工具，本仓库不包含其代码，也不依赖它运行。

## MIT 许可证原文（Wake，用于上面第 1 条的派生测试数据）

```
MIT License

Copyright (c) iAmCorey

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3. Claude Cookbook（做梦机制的思路来源）

- 《Dreaming with a dynamic workflow》（Anthropic Claude Cookbook，作者 Brad Abrams）：本项目的「夜间做梦」机制（导出会话 → 逐个分析 → 收敛成 wiki 式记忆库 → 未来会话只读挂载）参照该文思路实现；本项目未复制其代码或提示词原文，中文译文的提示词为改写版本。
