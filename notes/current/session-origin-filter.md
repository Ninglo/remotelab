# Session origin 筛选：实现与修复记录

2026-09-15 补充：`session-spawn` / handoff 创建的独立子会话默认属于 Chat UI，
来源不再继承父会话的连接器标签。旧的可见委派会话在没有 conversation、
sourceContext、externalTriggerId 或 completionTargets 时自动修正来源；
内部会话、访客会话及真实连接器绑定保留。修复保留 ID、历史、时间戳与归档状态。

同日补充：已读／未读的视觉提示仅适用于 Chat UI 来源且没有外部 conversation
绑定的会话。其他来源不显示 `review` 未读提示，也不应用“已完成且已读”的标题
淡化；运行状态仍显示。缺省来源按 Chat UI 处理，独立 handoff 子会话沿用此规则。

更新：2026-09-14。范围：浏览器 Sessions 侧栏的来源筛选、状态同步与后台刷新竞争。

## 结论

不需要重写整个前端。问题集中在来源筛选的状态归属和 DOM 更新方式，本次做了局部重构，保留原生 select、现有 Store 和无构建工具的前端结构。

修复前在实际部署页面复现：All Origins 共 62 条；正常选择 Chat UI 显示 3 条。模拟原生控件已发出 input、尚未处理 change 时到达一次后台刷新，控件和筛选状态被改回 All Origins，列表仍显示 62 条，控制台没有错误。

## 完整数据与交互链

| 阶段 | 实现位置 | 职责 |
| --- | --- | --- |
| 页面与控件 | `templates/chat.html` | `sourceFilterSelect` 是原生 select；`sessionList` 是侧栏会话列表；Space、搜索为另外两个筛选维度 |
| 定义与初始化 | `static/chat/bootstrap.js` | 定义来源分类、持久化键，创建 Chat Store；先读 `activeSourceFilter`，再兼容旧 `activeAppFilter` |
| 状态存储 | `static/chat/session-store.js` | `activeSourceFilter` 属于 Store；会话列表的替换不会覆盖它 |
| 读取与提交 | `static/chat/bootstrap-session-catalog.js` | `getCurrentSourceFilter()` 读取并规范化 Store；`commitSourceFilterSelection()` 统一处理 input/change |
| 来源分类 | 同上 | `sourceId` 经 `getEffectiveSessionSourceId()`、`getSessionSourceCategory()` 映射到筛选值 |
| 列表请求 | `static/chat/session-http.js`、`session-http-helpers.js` | 获取 `/api/sessions`；归档按需从 `/api/sessions/archived` 获取。切换 origin 本身不发筛选请求 |
| 请求结果应用 | `static/chat/session-http-list-state.js` | 规范化记录、更新 Store、刷新来源目录；会话数据发生变化才重绘列表 |
| 过滤 | `bootstrap-session-catalog.js` | `matchesCurrentFilters()` 将 origin、Space、搜索以 AND 组合；置顶、普通、归档使用同一谓词 |
| 绘制 | `static/chat/session-list-ui.js` | 根据 origin 和搜索生成 Space 选项；当前 Space 不存在时回到 All Spaces，再绘制置顶、Project 分组和归档 |
| 实时刷新 | `static/chat/realtime.js`、`session-http.js` | WebSocket 提示触发 HTTP 刷新，另外有列表、前台恢复和单会话更新路径，都会影响侧栏 |
| 空结果与辅助操作 | `session-surface-ui.js`、`session-http.js` | 空结果文案和列表整理范围从同一筛选状态读取 |

点击来源后的顺序为：

1. 原生 select 发出 input（或仅 change）。
2. 将控件值规范化；若与 Store 相同则结束，避免 input/change 重复绘制。
3. 写入 Store 和 localStorage。
4. 用 Store 中的 origin 重新计算 Space、置顶与普通会话，绘制列表和归档。
5. 刷新来源选项；用户仍在操作 select 时，延后这一步的 DOM 改动。

打开中的聊天不会因过滤被隐藏在侧栏而自动切换到另一条会话。

## 来源、数量及其他筛选的语义

来源规则集中定义在 `bootstrap.js`，按顺序匹配：

- `chat`（包含没有显式 sourceId 的默认记录）归类为 Chat UI。
- `automation` 及其前缀归类为 Automation。
- `email`、`mail`、`gmail`、`feishu-mail`、`lark-mail` 及相应前缀归类为 Email。
- `feishu`、`lark`，以及 `feishu-bot` / `lark-bot` 前缀归类为 Feishu。
- 其他来源归类为 Bots。

下拉数量统计全局未归档、非内部会话，包括置顶；不随 Space 或搜索收窄。因此存在“Chat UI (3)，当前 Space/搜索下只显示 1 条”的正常情况。

归档记录延迟加载，来源目录原本由活跃会话决定，本次保持这一范围。新增约束是：已选来源即使活跃计数变成 0，也保留它及 All Origins，显示空结果并允许用户主动清除筛选，且不丢失该来源已加载的归档结果。

## 根因与对应修复

### 后台刷新覆盖原生交互

原实现每次 `refreshAppCatalog()` 都清空 `select.innerHTML`，重建所有 options，并把 value 写回旧状态。即使数据完全没变化也会发生。它既可能干扰原生菜单，也能在原生选项变化与 change 事件之间丢掉用户选择。

现在：获得焦点时不改选项、选中值和可见性；未获得焦点时比较选项值序列，仅来源集合改变才重建。数量/翻译变化只修改有变化的文本；完全相同的刷新不改 option DOM。blur 后延迟一个任务再应用最新状态，使原生选择事件有机会先结束。

同时 input 和 change 使用同一个幂等提交函数，用户选择尽早进入 Store。

### 两套内存状态可能分叉

原实现同时保留 Store.activeSourceFilter 与全局 `activeSourceFilter`。Store 订阅同步了 sessions 等字段，却没有同步该全局值。正常 change 路径手动维护二者，看似可用；其他 Store 更新后，列表仍可能使用旧值。

现在移除全局镜像。来源过滤、Space 构建和空结果文案统一读取 Store。localStorage 是刷新页面后的恢复入口，不是运行时另一套状态。

### 渲染隐式清除用户选择

原实现发现已选来源没有活跃会话，会在绘制选项期间把筛选改成 All Origins 并持久化。自动归档或其他会话变化可能因此让用户选中的来源被悄悄清除。

现在选项渲染只负责显示，不改写选择。合法的零结果来源保持选中。无效/已移除的筛选值仍在初始化时规范化为 All Origins。

## 验证与证据边界

- 新增 `tests/test-chat-sidebar-filter-interaction.mjs`：使用真实 Store 包装、整个来源模块、HTTP 列表应用模块和列表绘制模块。只简化 DOM 与会话行装饰，不替换筛选谓词或点击处理。
- 最初 6 项中 5 项失败；修复后扩充为 8 项并全部通过：点击结果、input/change 竞争、无变化刷新、焦点期间数量变化、零结果/归档、Store/Space/搜索、change-only/重复事件、持久化恢复。
- 完整 `npm test` 通过，包含 merge-safety、原生 Harness 及 connector 回归。
- `git diff --check` 通过。`lint:filesize` 为报告模式，退出 0，但仍报告仓库既有大文件；未宣称全仓结构债务清零。
- 在实际 HTTPS 域名用 Chromium 桌面/移动视口各切换 60 次，各穿插 30 次刷新并额外执行 40 次无变化刷新。列表数量与实际筛选谓词一致，后者产生 0 次菜单 DOM mutation；无 pageerror，桌面键盘与刷新后恢复通过。
- 4 个已变更前端文件从实际域名读取并与 checkout 逐字节比对一致。前端指纹由文件时间变化自动更新；这次纯前端修复不依赖重启后端。
- 浏览器验证使用临时测试 profile，仅放行站点 GET，拦截写请求；未发送消息或改变服务器上的会话内容。Chromium 移动视口不等于真机 Safari，未声称完成 Safari 系统原生菜单验证。

## 后续是否继续重构

此次局部重构已经覆盖复现问题。其余 Space、列表展开和会话重命名仍有各自的状态及全列表绘制逻辑；若出现独立的点击丢失/滚动位置问题，应该为相应交互补事件竞争测试，再按稳定节点或局部更新拆分。当前没有证据支持为此引入框架或重写整个聊天渲染。
