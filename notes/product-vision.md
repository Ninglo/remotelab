# RemoteLab Product Vision

_Last updated: 2026-03-06_

---

## 核心重构认知

RemoteLab 不是一个"我和 Claude 对话的工具"。
它是一个**管理 AI 工人的控制台**。

用户不是执行者，是 director。交互模型应该从"对话框"迁移到"工作台"。

---

## 两个核心痛点

### 1. 认知负载 vs. Session 并发管理

**问题本质**：用户每个需求创建一个独立 folder/session，当并发 session 增多时，人脑成为整合瓶颈——用户要记住每个 session 在做什么、卡在哪、需要什么决策。这是纯粹的认知开销，不是工作本身。

**目标**：在不降低管控力的前提下，让用户能够平行处理更多 session，同时脑子里装的东西更少。

### 2. 移动端场景的真实性

移动端是**预期场景**，不一定是实际场景。需要验证实际使用中：
- 手机端的主要操作是什么（快速审批？状态查看？长文本输入？）
- 移动端是否真正产生价值，还是桌面才是主场

**暂定结论**：移动端应该是"审批+快速指令"层，不是完整工作台。具体功能优先级等实际使用数据验证后再决定。

---

## 输入/输出比例假设

用户个人工作模式：写完消息 → 切 session → 等模型完成 → 回来看结果。

假设：**用户和模型的信息输出量接近**，导致阅读时间 < 写作时间。

如果假设成立，UI 应该给输入框更高权重，而非把大量视觉面积分配给模型输出。需要用使用数据验证这个假设（后续埋点方向之一）。

---

## 未来产品方向（已讨论，待细化）

### 分层输出（Post-LLM 处理）

每条模型回复，用第二次 LLM 调用将内容拆解为：

1. **决策层**：这条回复是否需要你做决定？如果是，决定什么？
2. **结果摘要**：做了什么 / 有什么结论（一句话）
3. **推理过程**：为什么这样做（可折叠）
4. **实现细节**：具体代码 / 操作步骤（深度折叠）

用户默认只看决策层 + 结果摘要，其余按需展开。

### 跨 Session 进度侧边栏（Sidebar）

见下一节详细设计。

---

## Sidebar 详细设计

### 它解决什么问题

用户当前痛点：多 session 并发时，**用户的大脑是唯一的状态整合点**。

- 要记住每个 session 在做什么
- 要记住哪些 session 在等自己的回复
- 要记住各 session 之间的依赖关系
- 切换 session 时需要重新读上下文来"恢复现场"

Sidebar 的核心功能是**把这些状态从用户大脑里卸载出来**，外化到一个实时更新的"进度文档"里。

### 不是什么

- 不是另一个对话框
- 不是项目管理工具（Jira/Notion）
- 不是 session 列表（那是已有的 UI）
- 不是用来替代用户思考的，而是**减少用户重复记忆的**

### 第一期形态（轻量）

**产品表现**：一个始终可见的侧边栏，展示当前所有活跃 session 的状态摘要，当任何 session 有新的完成状态时自动更新。

**核心 UI 结构**：

```
=== 项目全局状态 ===
更新时间: 2 分钟前

[ 需要你介入 ]
• auth-refactor   等待输入 → 问了 token 过期策略
• chat-layout     等待输入 → 需要确认 CSS 方案

[ 运行中 ]
• sidebar-impl    正在实现布局结构

[ 已完成 ]
• ws-bugfix       修复了 WS 断连问题 (指数退避, 最多5次重试)
• config-cleanup  清理了环境变量加载逻辑
```

用户扫一眼就知道：有2个 session 在等我，1个在跑，2个完事了。可以直接点击对应 session 跳过去处理。

### 底层实现（v1 已实现）

**架构**：每个 session 完成一轮对话（`onExit` 触发），异步发起一次独立的一次性模型调用，让模型总结本轮内容，更新 `~/.config/remotelab/sidebar-state.json`。这个后台调用默认复用该轮用户实际选用的 tool / model / reasoning 配置，而不是硬编码某个 agent。

**关键决策**：
- **不用持久 session**：持久 session context 线性增长。改用单次 LLM 调用，输入固定有界（上次 background + 本轮 events），输出覆盖旧记录
- **每个 session 只保留最新一条记录**，不追加历史——sidebar 是当前状态快照，不是历史记录
- **两层内容**：`background`（这个 session 整体在做什么）+ `lastAction`（本轮最重要的动作）
- **触发时机**：`onExit` 后异步触发，完全不阻塞正常对话流程
- **UI 刷新**：切换到 Progress tab 时立即 fetch，并每 30 秒轮询一次

**实现文件**：
- `chat/summarizer.mjs` — 核心逻辑
- hook: `chat/session-manager.mjs` `onExit` 调用 `triggerSummary`
- API: `GET /api/sidebar` → 返回 state file 内容
- UI: 左侧边栏新增 Sessions / Progress tab 切换

**v2 扩展**：可以在 sidebar 加入一个能对状态文件提问的 AI session（"现在整体进度怎样？"），该 session 只读状态文件，不读原始历史。

### 状态文件结构（草案）

```markdown
# Project State
_Updated: 2026-03-01 14:32_

## Sessions

### auth-refactor [WAITING]
Folder: ~/code/remotelab
Tool: claude
Last action: Asked about token expiry strategy — needs user decision
Key context: Refactoring auth.mjs, token expiry currently hardcoded to 24h

### chat-layout [WAITING]
Folder: ~/code/remotelab
Tool: claude
Last action: Proposed two CSS layout options for sidebar, needs approval
Key context: Implementing CSS grid, has dependency on sidebar-impl

### sidebar-impl [RUNNING]
Folder: ~/code/remotelab
Tool: claude
Last action: Writing initial layout structure
Key context: Brand new session, task is to build the sidebar component

### ws-bugfix [DONE]
Completed: Fixed WebSocket reconnection with exponential backoff
Key output: Modified chat/ws.mjs lines 61-67

### config-cleanup [DONE]
Completed: Cleaned up env var loading in lib/config.mjs
```

### 未解决的设计问题

1. **触发时机**：每条消息完成都触发？还是有 debounce（模型一次回复可能很快，避免频繁调用）？
2. **状态文件压缩**：状态文件本身如何避免增长？DONE 状态的 session 保留多久？删除后用什么摘要替代？
3. **"需要介入"的判断**：如何可靠地识别一个 session 是在等用户输入 vs 还在思考？（Claude 有时候会自己继续，有时候会问问题）
4. **折叠/展开**：状态文件里 key context 写多少合适？太少没用，太多 context window 还是会爆
5. **依赖关系**：session 间的依赖能否被自动识别（"chat-layout 依赖 sidebar-impl 完成"）？还是只能靠用户手动标注？
6. **从 sidebar 直接操作**：是否支持在 sidebar 里直接回复某个 session？（避免切换 tab）

---

## 待决策事项

- [x] Sidebar v1 的触发机制选哪个方案 — **已选定 onExit 触发，v1 已实现**
- [ ] 移动端场景优先级（等实际使用数据再定）
- [ ] 分层输出（Post-LLM 处理）何时排进迭代
- [ ] 埋点系统是否需要（低优先级，先把产品方向定了）

---

## App 系统实现状态（2026-03-06）

App 系统是 RemoteLab 作为 Agent 分发工具的核心——让 Owner 创建可分享的 AI 工作流，Visitor 通过链接使用。

### 已完成

| 能力 | 实现位置 | 状态 |
|------|----------|------|
| App 数据模型 (id, name, systemPrompt, skills, tool, shareToken) | `chat/apps.mjs` | ✅ 生产 |
| App CRUD API (GET/POST/PATCH/DELETE `/api/apps`) | `chat/router.mjs:409-496` | ✅ 生产 |
| Share token 生成与查找 | `chat/apps.mjs` | ✅ 生产 |
| Visitor 入口 (`GET /app/{shareToken}`) | `chat/router.mjs:142-179` | ✅ 生产 |
| Visitor auth session (role=visitor, scoped to appId+sessionId) | `chat/router.mjs` + `lib/auth.mjs` | ✅ 生产 |
| systemPrompt 注入到首条消息 | `chat/session-manager.mjs:396-404` | ✅ 生产 |
| 前端 visitor mode (隐藏 sidebar, 自动 attach session) | `static/chat.js` + `templates/chat.html` | ✅ 生产 |
| Auth info endpoint (`/api/auth/me`) | `chat/router.mjs:499-515` | ✅ 生产 |
| Owner session list 隐藏 visitor session | `chat/session-manager.mjs:97` | ✅ 生产 |

### 待实现

| 能力 | 优先级 | 备注 |
|------|--------|------|
| Visitor "新对话"按钮 | P1 | 当前每次需要重新点击 share link |
| Owner 的 App 管理 UI | P2 | 目前只能通过 API 或 agent 对话创建 App |
| 多 App 门户页 | P2 | 如果要分享多个 App，需要一个入口页 |
| App 使用统计 | P3 | visitor session 数据已保留，但无分析 |

### 验证记录

2026-03-06 在测试服务 (7692) 上创建了 "English Tutor Demo" App，通过 curl 验证了完整 visitor flow：share link → session 创建 → auth cookie → visitor mode redirect → systemPrompt 注入。前端 visitor mode 待真机浏览器验证。

---

## 不做的事（当前阶段）

- 不引入外部框架（保持 Node.js 内置 + ws）
- 不做通用化（单用户工具，不需要多租户、权限系统）
- 不过早优化（先把功能跑起来，再考虑性能边界）
- 终端服务（auth-proxy 那套）不改动
