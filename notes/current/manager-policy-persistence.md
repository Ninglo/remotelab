# Manager Policy Persistence

这次调整解决的不是某一句 prompt 的问题，而是 manager 状态如何在续聊中持续生效的问题。

我们把这件事拆成三层。第一层是全局 manager policy，也就是那些跨 session、跨 provider 都应该成立的基础规则，比如 RemoteLab 拥有默认 reply style，provider runtime 只是执行器，不应该把自己的 house style 反向投射成用户看到的表达。第二层是 session 级的 active agreements，也就是在当前会话里已经明确达成、并且应该继续生效的工作约定。第三层才是更重的历史、模板上下文、fork context 和压缩 handoff，这些仍然按需激活，而不是每轮都塞进 prompt。

当前落地的实现重点放在前两层。全局 manager policy 继续由 manager 自己在每轮 default prompt 中薄注入，避免续聊时完全退回 provider 默认风格。与此同时，session 新增 `activeAgreements` 元数据字段，用来持久化当前会话里已经成立的短约定；这些约定会在每轮 default prompt 中重新激活，但会严格限制条数和长度，避免把“持续提醒”重新做成一块很重的背景上下文。

这里有一个刻意的边界：本轮先做“显式持久化 + 每轮激活”，不做重的自动提取。原因是 transcript 中出现过的话，并不天然等于当前仍然生效的约定。如果过早自动总结，很容易把临时讨论、探索性说法或者已经被后文推翻的观点误提升成 manager 状态。更稳的方向是先把 manager 拥有状态这件事做对，再在后续只针对强信号做 agreement promotion。

因此，这一版的契约是：共识不再只存在于聊天历史里，而是允许被提升成 session state；一旦进入 `activeAgreements`，manager 会在后续每轮对话中持续激活它，直到它被显式更新或清除。这样一来，续聊不会再单纯依赖 thread 惯性，而是开始依赖 manager 自己维护的会话状态。

在可见性上，这些 manager 级提醒默认也不应该成为用户直接看到的聊天内容。它们属于水下上下文：对模型持续生效，但默认折叠在过程信息里，而不是作为普通消息露给用户。只有当用户主动展开隐藏过程块时，才需要保留查看入口。这样可以同时满足两件事：一方面让 manager policy 持续存在，不再随着续聊漂移；另一方面避免用户被这类底层提示文本打扰，或者因为看到一套自己并未直接提供的规范描述而产生困惑。
