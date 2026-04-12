## Durable RemoteLab Learnings

### Invisible Post-Turn Memory Writes Are Perceived As No-Op (2026-04-12)

- If a post-turn reviewer writes only to a backend candidate JSONL and produces neither a formal memory write nor a visible `context_operation`, users will consistently conclude that the feature did not take effect.
- The engineering issue is not just persistence but observability: a hidden candidate artifact does not satisfy the product contract for "memory saved" because neither the durable state nor the user-visible feedback channel changed.
- When debugging similar reports, first verify whether the system produced a real memory landing point and whether the turn exposed a visible context update; if both are absent, treat the report as a valid UX/contract failure rather than user misunderstanding.

- 对以后所有 RemoteLab 部署，一个稳定可复用的排查结论是：如果 post-turn reviewer 只把结果写入后台候选 JSONL，却没有形成正式 memory 落点，也没有产生用户可感知的 context_operation，那么应视为产品语义上“没有真正记住”，用户也会稳定判断为功能未生效。
- 排查类似记忆未生效问题时，应优先检查两点：是否生成了正式、可复用的 memory 写入落点；当前 turn 是否留下了用户可感知的 context 更新信号。若两者同时缺失，即使后台候选 JSONL 已写入，也应按“可观察性缺失导致的有效失败”处理。

- 在 RemoteLab 部署里，如果 post-turn reviewer 只把结果写入后台候选 JSONL，没有形成正式 memory 落点，也没有产生用户可见的 context_operation，应视为“功能未真正生效”，因为系统缺少可复用的持久状态与可观察反馈。
- 排查“后台似乎处理了但用户认为没生效”的问题时，优先核查两点：是否写入了正式且可被后续流程读取的 memory，以及这一轮是否提供了用户可感知的 context_operation 或等价上下文更新信号；若两者都缺失，应按“正式落点与可观察性双缺失导致的有效失败”处理。

## Learnings

- RemoteLab 的 CLI 设计应采用“机器级统一入口” `remotelab`，而不是按实例区分不同命令名；多实例差异应放在环境上下文里处理。
- 为 agent shell 注入稳定的 CLI 相关环境变量可减少硬编码路径：`REMOTELAB_CLI` 指向首选 `remotelab` 可执行入口，`REMOTELAB_CLI_JS` 指向 `cli.js` 作为绝对 fallback；实例隔离继续依赖 `REMOTELAB_INSTANCE_ROOT`、`REMOTELAB_CHAT_BASE_URL`、`REMOTELAB_SESSION_ID`。
- RemoteLab 的 memory 写回能力应采用混合策略：代码负责边界与可写 target catalog，模型只在合法 target 中智能选路，不允许自由写任意路径。
- memory 写回不应被固化到 RemoteLab 通用项目文件；默认应优先路由到用户个人记忆体系中的更具体文件，只有无法明确归类时才回退到 auto fallback。
- RemoteLab 的边界是：不能决定模型/runtime adapter 是否发起 `bash`/本地工具调用，但一旦进入本地 runner，实际 `spawn` 出来的进程 `cwd`、`PATH`、`env` 由 runner 注入并可控。
- RemoteLab 的实例分流应通过 runner 预注入环境变量实现，而不是让模型自行 `export`。固定暴露统一的 `remotelab` 命令，实例上下文通过 `REMOTELAB_INSTANCE_ROOT`、`REMOTELAB_CONFIG_DIR`、`REMOTELAB_SESSION_ID`、`REMOTELAB_RUN_ID` 等环境变量传入。
- 在会话分流方案上，用户确认优先采用“近乎完整继承”而不是摘取式继承；如果目标是接近完整上下文，就直接传完整高亮信息，以降低实现复杂度并尽量命中模型缓存。
- 对于新开会话，用户接受由 planner 先做一个简短总结，再用这个总结去开启新会话的流程；建议先做一版上线验证效果。
- 在推进新分流方案时，用户明确要求打开相关开关，并清理旧有脏概念，避免为了兼容保留历史包袱导致代码变丑。
- 语音识别直连设置里切换后自动回退到 legacy relay 的根因，是服务端旧进程仍在使用不含 `provider` 字段的旧设置 schema，保存时会吞掉该字段；重启对应 chat-server 进程后即可正常持久化 `provider=doubao_gateway_direct`。
- 在产品文案上，不应把直连语音 API 所需的认证暴露为容易误解的“gateway API key”；对用户侧应收敛为更接近“Realtime API key”的表述，因为它本质上是官方直连 API 的认证 key，而不是额外中间层概念。
- 在 RemoteLab 的会话分流架构里，connector 型个人助手入口（如微信、飞书）应先做一层 `inline_assist` vs `sessionized_work` 判定：自包含、可当场完成、无需长期上下文的请求直接原地回复；只有复杂、需持续跟进或沉淀产物的任务才进入会话化流程，再由 continuation planner 判断 `continue` / `fork` / `fresh`。
- RemoteLab 的会话分流先采用轻量策略：默认一轮只做一次分流，不引入新的顶层产品模型；简单的一次性查询留在当前会话解决，只有任务明显复杂、明显与当前上下文严重不匹配，或同条消息里包含多个可拆分任务时才拆分。
- RemoteLab 当前不需要强硬支持会话入口分流场景；分流能力以“可感知但不过度触发”为原则，后续有真实需求再逐步增强。
- RemoteLab 分享页如果同时输出 `<base href>` 和 `Content-Security-Policy: base-uri 'none'`，浏览器会忽略 `<base>`，导致相对静态资源被解析到 `/share/...` 路径并被分享快照路由误处理，最终返回 `text/plain` 而触发 MIME 错误。修复方向是让分享页 CSP 允许 `base-uri 'self'` 或改为不依赖被禁用的 `<base>`，并确保静态资源不落到分享快照路由。
- RemoteLab 的 reply self-check / self-repair 流程分两跳且上下文不同：review 阶段只看当前 user message + 当前这轮已展示给用户的 assistant turn；若判定继续，repair 阶段会收到原始 user message、上一条 assistant turn、reviewer 的 reason，并再叠加正常的 session continuity。
- RemoteLab 的 continuation history 不是固定把所有历史原样重放：若底层支持 resume thread/session，通常依赖底层线程上下文；否则由 RemoteLab 注入规范化后的历史，可能是摘要 + 最近事件且会截断。self-check 追加的普通状态卡片通常不会进入 continuation history。
- 公开页/分享页如果依赖 `<base href>`，必须同时保证响应头里的 CSP `base-uri` 允许同源（如 `base-uri 'self'`）；否则浏览器会忽略 `<base>`，静态资源可能按当前分享路由错误解析，进而触发资源路由错配与 MIME 异常。
- 针对公开页/分享页的回归测试，应成对覆盖这几个约束：HTML 中存在正确的 `<base href>`、响应头允许其生效的 `base-uri`、以及在前缀代理场景（如 `x-forwarded-prefix`）下资源 URL 仍落到正确静态路由。
- 公开页资源路径应统一使用相对产品根路径的写法，避免使用 `../` 这类向上跳目录的相对路径；这样在分享路由、子路径部署或前缀代理下更稳健。
