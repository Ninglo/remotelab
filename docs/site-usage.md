# 员工网站行为采集与只读汇总

给 Agent 的接入要求：

> 在原员工站服务中接入 `handleSiteUsageRoutes`，复用已核身份和现有控制台鉴权。
> 对服务端确认的员工站 HTML 集中加载 `/site-usage.js`，不逐站修改源文件。
> 保留原 URL、登录态、访问策略、CSP 和在途响应；验证未登录不采集、员工可采集但不能读汇总、原控制台读取权限保留。
> 复用现有入口与登录，真实使用数据从启用后产生，不伪造生产测试事件。

本实现复用 `employeeSitePerson` 和 usage-events schema v1 的写入器，独立保存到实例配置目录的
`site-usage-events/`。员工站事件不写入控制台的 `usage-events/`，不改变原有会话、消息、功能使用量的分母或计数。
`chat/usage-events.mjs` 仅增加服务端上下文 `verifiedSiteId` → `siteId`，保留原事件白名单、字段和统计逻辑。

## API 与身份边界

| 接口 | 鉴权与行为 |
| --- | --- |
| `POST /api/site-usage/events` | 同源 Origin；`employeeSitePerson` 的已核员工浏览器身份；同源 Referer 必须匹配当前登记的受管站点。成功持久化返回 `202 {"recorded":true}`。 |
| `GET /api/site-usage/summary?days=7&site=static:example` | 保留现有 RemoteLab 控制台鉴权，包括原有 service 读取权限。`days` 为 1–30，`site` 可省略。员工 Cookie 本身不授予读取权。 |

网站范围由服务端从 Referer 路径和当前发布记录确定：

| 页面 | `siteId` | 核验来源 |
| --- | --- | --- |
| `/public-pages/<slug>/...` | `static:<slug>` | 发布根目录下 `<slug>/_remote_publish.json` 的 `access: employee` |
| `/preview/<slug>/...` | `preview:<slug>` | `preview-routes.json` 中有效端口及 `access: employee` |
| `/sites`、`/sites/` | `directory` | 原有统一员工身份入口 |

未配置、未登录或过期返回 401；跨源、缺 Referer、未登记、public/basic 站返回 403；
批次格式错误返回 400，超出 32 KiB 返回 413，登记损坏或写入失败返回 503。
这些接口不跳转登录、不创建新身份、不签发控制台会话。Cookie 的正常续期仍由现有身份模块处理。
缺少同源 Referer 时停止采集，不放宽到客户端自报 site。

## 事件、隐私和统计口径

批次格式：`{"events":[{"event":"page_enter","eventId":"UUIDv4","visitId":"UUIDv4"}]}`，每批 1–50 条。

| 事件 | 附加值 | 采集条件 |
| --- | --- | --- |
| `page_enter` | 无 | 顶层文档首次可见；BFCache 恢复时使用新 visitId |
| `page_visibility` | `state: foreground / background / leave` | 已可见文档的可见性切换或 pagehide |
| `ui_action` | `action: open / download / preview` | 真实点击带 `data-site-usage-action` 的元素；不推测按钮含义 |

服务端按字段白名单重建事件，采用接收时间，忽略客户端 timestamp、person、site、Session、object、URL 和任意扩展属性。
person 使用现有 `usageKey(person:...)` 哈希；eventId、visitId 按已核 person + site + 原 UUID 分区哈希，
避免另一人或另一站复用 UUID 抑制事件。日志文件为 0600，目录为 0700。
不记录姓名、飞书标识、IP、正文、标题、路径后缀、查询参数、href 或完整 Referer。
siteId 保留受管站点的 slug，便于关联总站；汇总不返回 personHash、visitId 或原始事件。

脚本不读取 Cookie、localStorage、sessionStorage 或 DOM 文本。采用同源 fetch + keepalive，
没有登录弹窗、提示、页面跳转、后台轮询或持久重试队列。401/403/404 等不可恢复响应后停止；
网络失败或 503 保留最多 50 条内存事件，下次事件或 `RemoteLabSiteUsage.flush()` 重试，保持原 UUID。
卸载时独立发送 leave，即使先前请求尚未返回。浏览器限额、断网、关闭进程或队列满仍可能丢事件。

汇总提供总量、逐站、逐 UTC 日的页面进入数、去重人员数、visit 数、显式动作和可见性事件。
people/visits 按窗口内任意有效事件去重，因此前台切换可使跨窗口旧访问在新窗口中出现，pageViews 只数 page_enter。
数字代表浏览器观测，不证明阅读、任务完成、动作成功或停留时长；Referer 和客户端事件可由已登录本人模拟，不作为安全审计证据。

查询等待本进程已受理的写入完成，只读取账本，不创建目录或初始化采集标记。
重启后的重复 eventId 仍只计一次；扫描超过 20 万行或 32 MiB、损坏记录、已知缺口或本进程写入失败时
`coverage.incomplete` 为 true，所得计数为部分观测。预算可通过 `createSiteUsageStore` 参数调整。
`collectionStartedAt: null` 表示尚无采集起点，不表示完整零使用量。
首次写失败且无法写健康回执的故障在本进程可见；现有写入器在恢复后的成功写入中持久化缺口，
恢复前进程即退出则无法保证保存该失败回执。正常读取不会回填历史。

## 已接通的集中入口

当前由 `router.mjs`、`router-site-directory.mjs` 和 `preview-proxy.mjs` 集中接线，员工站源文件不需要逐站修改。

1. `router.mjs` 导入 `handleSiteUsageRoutes`。在控制台 `requireAuth` **之前**只将
   `pathname === '/api/site-usage/events'` 分派给它；沿用员工身份独立采集。
2. 在现有 `requireAuth` 成功并取出 `authSession = getAuthSession(req)` **之后**调用同一 handler，
   传入 `{ req, res, pathname, authSession }`，用于 summary。不得从员工 Person 构造 authSession。
3. `/site-usage.js` 可由已有静态文件解析器直接提供。脚本必须从员工文档的同源入口加载，
   fetch 的 Referrer-Policy 固定为 same-origin，只在 HTTP 头中供服务端匹配站点。

HTML 响应边界通过 `site-usage-html.mjs` 插入共用脚本标签
`<script defer src="/site-usage.js"></script>`，已有同标签时不重复添加。
静态响应只处理已通过 `checkEmployeeStaticAccess` 的 employee HTML；preview 只处理
`access: employee` 上游的成功完整 HTML 响应；总站在服务端模板输出时走同一步骤。
当前与后续员工站、总站自动接入；已启用 `reuseIdentity` 的旧 Basic 站仅在该人拥有原站映射时接收事件。显式启用 `recognizeIdentity` 的公开旧站只为已核员工采集，匿名访问保留原行为。未接入的 public/basic 站、控制台、JSON、图片和其他资源不注入。

接线需沿用原 CSP 的 nonce/script-src 规则（标签需要 nonce 时复用该响应 nonce），
保留 private/no-store、登录续期 Set-Cookie 和其他业务头。若原 HTTP CSP 的 connect-src 禁止采集，只向该指令增加本站完整的 `/api/site-usage/events` 路径；不放行其他接口或外部域名，其他 CSP 指令保留。
动态 HTML 转换需同步处理 Content-Length、ETag、压缩编码；不注入 HEAD、Range/206、304 或错误响应，
不能直接把字节追加到压缩内容。可在该 HTML 通路请求 identity 编码后仅转换未压缩完整文档，
保持其他响应透传；若原策略无法加载同源脚本，则留为明确接线缺项，不放宽访问策略。
脚本在已核个人的成功完整 HTML 响应中集中加载。原 CSP 禁止脚本时不放宽脚本策略；连接限制只增加同源采集接口的精确路径；流式 HTML 只缓存有界 head，压缩、Range、错误响应保持原样。

扩展到独立域名或其他外部网站，需要其自己的同源受管入口和服务端站点登记；此实现不跨域发送身份。
总站外部链接登记本身不构成该网站已接入采集的证据。

## 验证与关闭

运行 `node scripts/run-with-clean-instance-env.mjs node --test tests/test-site-usage.mjs`。
测试先隔离 HOME 和全部实例路径，再导入运行模块；真实 loopback HTTP 使用临时员工会话、站点和独立账本，
覆盖身份/站点伪造、过期与服务凭据、原控制台读取、批次拒绝、脱敏、权限位、重启去重、扫描截断、
损坏与存储故障，以及脚本可见性、BFCache、静默失败、重试 UUID 与卸载并发。

关闭时停止集中注入和 events 路由接线，保留历史账本和只读查询。删除脚本接线不会影响既有登录、网站内容或在途业务操作。
本地测试不替代主话题接线后的真实页面/CSP 验证；生产自然使用验收不得伪造事件。
