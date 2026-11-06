# 做梦请求（message 模板）——对齐 cookbook 的 `prompts/work_request.md`

把下面这段填好占位符后作为「做梦请求」发给 lead 提示词。它用大白话说明这次梦要做什么，
具体的 workflow 由 lead 按 lead 提示词自己写。

---

对下面这些转录做一次梦：把它们揭示的东西萃取进记忆目录 `{mem_dir}`。

<inputs>
{input_paths}
</inputs>

你手上有两个预定义角色。`{analyzer_name}` 读**一份**转录，把它学到的东西加进记忆；
`{organizer_name}` 在分析者都做完之后，把整份记忆收敛成一套可导航的库。
把它当作一次 workflow run 跑完，然后告诉我发生了什么。

当天的会话一共有 {input_count} 份。按每批约 {batch_size} 份分组，做完一组再开下一组。

---

## 本实现的适配说明（与原文的差异，写在这里以免误读）

原文里 analyzer / organizer 是持有 read/write/edit/glob/grep 工具的 agent，自己往记忆目录里写文件。
WakeDream 是**本机客户端**，要能在没有 API key 时降级，所以：

- 结构化的写盘由 `dream/organize.js` + `dream/indexer.js` 统一做（形状固定、可单测、可幂等重跑），
  模型侧只负责**读、核验、萃取成结构化的 JSON**；organizer 那一轮负责**跨会话的合并与冲突判定**。
- heuristic provider 走同一套阶段函数，只是用规则代替模型调用。
- 因此 `{input_paths}` 里的转录是**逐份喂给模型的文本**，而不是沙箱里挂载的文件。
