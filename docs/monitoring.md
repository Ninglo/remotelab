# Operations overview

## 组织知识库按需调用与持续监管

可交给实例 Agent：“将现有组织知识库的按需调用接入 Claude Tag 持续功能监管，先只对我生效；记录入口、正文读取量和次数、Token、时延及实际效果。复用原采集，不增加群消息或另一套定时监控。”执行者须核对当前已验证 Person、既有知识目录及原监管站点；默认关闭，配置不从公开网页接受。

实例配置 `CONFIG_DIR/knowledge-pilot/config.json`：`{version:1,id:"organization-knowledge-v1",projectId:"claude-tag",name:"组织知识库调用",enabled:true,enabledAt:"ISO时间",personIds:["明确授权的Person"],corpusPath:"现有知识库绝对路径",verificationRequestIds:[]}`。范围变化使用新 id 保留旧记录；关闭 enabled 停止新的入口和读取，保留统计。Person 只界定调用试点，知识内容仍归组织。Web、飞书的已验证本人普通输入可获得短入口；自动任务、内部调用和群主线背景处理排除。其他成员不继承。该试用持续运行，未设自动到期日；不改变原有七天自检观察窗口。

需要按群试用时，显式配置 `groups: [{sourceRouteId:"已授权Bot路线",tenantKey:"租户",chatId:"已授权群"}]`。个人名单和群名单取并集；群匹配只使用当前已认证飞书输入的路线、租户和群 ID，要求已核 Person/identity，群主线背景处理、自动任务和内部调用继续排除。群内普通成员无需加入全局个人名单；群授权不随成员延伸到其他群、私聊、网页或群绑定 Session 中的网页输入，也不沿父子会话继承。`personIds` 可为空，但两种范围至少配置一种。入口捕获和实际工具读取共用范围判断；去掉群后停止该范围的新入口及后续读取。群扩围不会开启其他个人试验、分流或异步检索。输入记录保留命中的群范围，原效果、耗时与返回量计量沿用。

每条符合范围的新输入捕获独立开关和检索策略，并把短入口放进原规则上下文及恢复快照。Agent 判断是否需要历史经验：无关问题无需调用，不增加一个路由模型。命令仍为 `remotelab knowledge search --query <问题>`；证据不足时用 `read --page <文件名>` 展开原页。已接纳输入保留原策略，开关关闭则阻止所有新读取。

未配置 `retrieval` 时仍为 `catalog-routing-v1`：`search` 返回最多8条词面提示和完整 `catalog`（标题、文件名、适用场景），由 Harness 按含义选页。目录不是正文，不把词面排名当置信度。选择 `retrieval.strategy: "hybrid-rerank-v1"` 后，搜索使用 jieba/BM25 与 multilingual-e5-small，RRF(k=60)合并，候选12段由多语言MiniLM CrossEncoder重排，默认最多3段、条目字段与正文2200字符；来源元数据另计。原段落、标题、适用条件、原页哈希、来源和知识版本随 `passages` 返回；不再附全目录，也不默认追加选页、改写或摘要生成调用。排名不保证真实性或完整性；冲突保留双方原证据，由 Harness 按对象、时间和条件判断。

可交给维护Agent：“在原本人试点启用混合检索与重排，使用已核模型和依赖，核验原调用接口、原文来源、监控和回滚；不要扩大人群。”维护者在实例外置运行目录按 `knowledge/requirements.txt` 安装可选CPU依赖，保存模型文件及散列，在配置 `retrieval` 中填写绝对路径 `python`、`embeddingModelPath`、`rerankerModelPath` 和 `strategy`。模型分别为 `intfloat/multilingual-e5-small` 与 `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`。可调参数为 `cpuThreads`(默认8)、`candidateCount`(12)、`maxPassages`(3)、`maxEvidenceChars`(2200)、`timeoutMs`(30000)；不是永久容量限制，调整需复验本实例的成本与效果。

Python计算运行在控制服务的可选子进程，使用私有Unix socket；模型首次查询载入并驻留，知识内容或索引改变时重建索引。CPU运算不阻塞Node事件循环；运行时禁止联网下载，模型或依赖缺失明确报错，不静默扩成全目录。没有新定时任务或独立对话服务。停掉控制进程会关闭worker输入管道并回收子进程；可安全重启后重建缓存。冷启动及建索引成本与热检索分别记录，工具耗时包括当次等待，不能只展示热路径数字。

后台建索引读取现有语料不代表全库进入生成模型上下文；只把选出的片段返回。所有正文文件沿原真实路径检查，拒绝越界、非索引页和超大文件；工具不修改知识库。重复读取保留次数，同一 operation-id 的传输重试幂等。回退新输入到 `catalog-routing-v1` 时保留模型路径，让已接纳的混合检索输入继续原策略；关闭 enabled 则停止读取。回滚保留原输入、来源、事件和自然观测，不恢复旧数据覆盖新工作。

实际读后，原 Harness 可用 `remotelab knowledge report --file <JSON>` 回报 `{effect:"helped|no_change|misled|unknown",reason:"具体改变的判断或没有帮助的原因",evidenceSeqs:[原任务工具/附件事件编号]}`。非 unknown 需要实际事件引用；效果保留为 Agent 自评，不能当作人的验收或因果收益。未读正文、读后未回报、无法判断分别保留；无需让用户每次填表。新增真实反馈仍在原工作记录中核查。

测试期若本人要求在答复中看见采用标记，可在同一试用配置增加 `helpedLabel`（单行、最多80字符）。只对该配置已经授权的人群生效，默认不添加。Agent 实际读取知识正文、用于当前判断或行动且效果记录为 `helped` 后，在相关答复里标注一次该文字；只收到入口、搜索目录、未采用或效果未知不标注。标记是 Agent 的采用说明，不是独立验收，也不触发额外读取。规则随新输入捕获，已接纳输入及重试保留原版本；配置撤除该字段停止新标记要求。 需要按具体发现归因时配置 `helpedCitation: "finding-source"`，优先替代固定标签：答复填写所用条目、实际采用的发现及原始来源，保留讨论／推断和实验结果的区别。`read` 及混合检索的片段在正文之外返回 `title` 与当前索引中的 `sources`（来源身份、类型、时间和原件入口）；旧索引无该字段时返回空列表，不能据此编造作者。索引由知识库原来源表构建，正文内的逐条引用负责将发现对应到具体来源。该引用是 Harness 的实际使用说明，不是后台自动判定发现正确。 新的简明样式使用 `helpedCitation: "experience-source"`：`【参考组织 Wiki 中〈实际来源〉的经验：〈本次实际采用的要点〉】`，随后附可用原文链接；来源按原材料的真实作者、团队或条目填写，流程／报告／源码按实际材料称为方法／记录／源码。只有实际采用且效果记录为 helped 时标注；仅检索或读过不标，也不代表已在当前任务中验证有效。旧的 `finding-source` 和固定标签仍由已接纳输入快照保留，新样式只随新输入捕获。

监管复用 `/api/monitoring/feature-observations` 及原独立站120秒采集，在 Claude Tag 的“新功能持续跟踪”和“案例汇总 → 持续产出物 → 组织知识库”展示。公开只输出聚合；正文、身份、原任务和具体证据只在原认证入口可见。安装验证 request 明确列入 verificationRequestIds，从自然样本排除，不把测试次数当真实收益。后台读取错误由接口保留缺口，不能填为零。

计量分别说明：入口准备量及原生接收、检索次数、正文/目录返回、重复读取、返回字符量；混合搜索带回正文时同时计为一次查询与正文返回，重复量按实际返回页去重；关联执行的输入/缓存/输出 Token 按 run 去重，先扣除线程早先任务的累计计数。共享执行可能包含补充输入，不能归成每条输入的独占用量。已结束执行的计量缓存供原采集读取。净增 Token 需要另有对照，未测保持 null；字符不伪装成精确分段 Token。首条内容/回复沿现有实际飞书投递回执，Web或无回执为未知；任务完成按原 Request 结算，服务端知识读取单列。不把首条开场当作有用最终答案。直接绕过入口读取本地文件、压缩后知识是否保留，不在此工具覆盖范围内。

验证：`node tests/test-knowledge-pilot.mjs` 覆盖默认关闭、本人/他人/自动任务范围、认证群范围及群外/私聊/网页隔离、群撤回与新旧引用样式、实际 Prompt 入口、正文读回、重试/重复、越界路径、效果证据、安装验证排除及 Token 前缀/重置。`tests/test-knowledge-retrieval.mjs` 补测策略冻结、本人范围、缓存失效、片段来源、正文统计、重试、显式故障与回退。模型运行验收另在隔离配置中使用实际语料和已安装CPU模型检查冷/热、关键证据及原监控。原监管站须同步知识专用展示；仅改配置或源码不代表完成部署。

## 新功能持续观察

`GET /api/monitoring/feature-observations` 沿现有实例认证提供观察汇总；`?view=1` 提供原工作、检查项、事件编号及阶段用量。公开监管页的 **AI Labor → Claude Tag → 新功能持续跟踪** 通过既有 120 秒采集器只读这个接口；公开投影不含 Person、原任务正文或检查证据，证据入口需要登录。前端补丁维护在该实例原监管站点，部署须与本接口配套；未部署不表示已开始观察。

配置位于 `CONFIG_DIR/feature-observations/config.json`，不存在即关闭。下面的 Person 是占位值，不能作为迁移或代人授权：

```json
{"version":1,"trials":[{"id":"delivery-review-week","projectId":"claude-tag","featureId":"delivery-self-review","name":"交付自检一周观察","enabled":true,"durationDays":7,"personIds":["person_explicitly_authorized"],"metrics":[{"id":"found","label":"发现的交付或验收缺项数"},{"id":"fixed","label":"在授权范围内修复并重验通过的缺项数"},{"id":"unresolved","label":"仍未解决的缺项数"}]}]}
```

配置只选观察对象，不替其开启功能。首条符合本人及功能选择的输入接纳后开始七天窗口；一周以墙钟计时，暂停不顺延。窗口结束停止新输入加入统计，保留已有数据和用户开关；自检执行回执与回复标志继续生效。试点由 Person 白名单界定，项目 ID 是监管归属，不能据此把他的其他已授权输入声称为该项目的业务成果。当前适配器是交付自检；其他新功能可复用登记、窗口、证据、计量和页面，需补其实际触发位置与指标定义。更换范围或指标使用新观察 ID，不覆盖旧窗口。

| 计数或指标 | 依据 |
| --- | --- |
| 已启用输入 | 接纳时冻结的实际个人／群策略；补充输入单独计数 |
| 原生已接收 | 追加输入的 nativeReceipt.accepted；根输入使用 provider 的 turn.started 回执。缺回执保持待确认，进程退出不替代接收证据 |
| 自检执行数 | 同一原生运行的一次 begin；重试幂等，多条补充不重计 |
| 效果 | finish 中的通过、修复后通过、阻塞、不适用，以及可配置缺项计数；标为 Agent 自报 |
| 验收证据 | 引用原 Session 已存在的工具结果、文件变化或附件记录；纯“我完成了”的文本不能充当证据 |
| 消耗 | begin 与 finish 各自之后首个 provider 采样的累计输入、缓存输入、输出差值；按天汇总并显示有计量／未知覆盖 |

自检执行回执独立于七天观察。凡原输入已开启自检，均可记录 begin/finish；观察未配置或到期不影响本轮回执。正常检查通过、不适用、无记录及回执状态异常均不显示尾注。只有自检发现问题后额外推进了工作（repaired）或推进受阻（blocked），最终答复才附一行、不超过 15 字的短注，例如“自检补做：已补齐下载”“推进受阻：待提供目录权限”；不把任务成果和格式调整充作自检发现。完整原因、已做检查与修复、后续负责方和用户动作保留在原回执中；实际影响交付的问题和必须由用户完成的动作在正文说清一次，不能只藏在回执里。检查总数、通过／未通过／待确认计数保留在详细记录，不挤进短注。

所有状态及原因仍存原回执与观察统计。已开始未完成、无记录和读取失败只表示记录状态，不能据此认定业务推进失败。旧回执没有短注时仅对补做和受阻显示已有状态，不编造原因。用户可在原话题回复“核查本轮自检”，由 Harness 沿原工作查实际记录，不重做原任务。状态本身不启动续跑。沉默回复不因此产生文字；重发保留已冻结的原回复，不改写状态或重复发送。认证接口加 `sessionId`、`requestId` 可读取原输入的实时自检状态（含 `checkDetails` 和 `explanation`）。公开统计保留运行中待自检、已结束无回执和已开始未结束；原输入清单及验收证据只在认证页显示。没有采集的历史不补填。

运行中的本人输入或服务执行身份可用 `remotelab feature-observation begin --request-id <id>`，完成核对后 `finish --request-id <id> --file <结果JSON>`。结果包含 outcome、非负整数 metrics、checks（criterion、verdict、evidenceSeqs）以及 explanation：

| 字段 | 按本轮实际情况填写 |
| --- | --- |
| note | 不超过 8 字的具体原因或动作，不换行；与状态合计不超过 15 字，例如“已补齐下载”“待提供目录权限”；仅补做或受阻时显示 |
| reason | 为什么本轮需要自检；不适用时说明没有额外产物验收的具体原因 |
| actions | 实际完成的检查、修复操作数组，不用计划充当已做；不适用时可为空 |
| nextStep | 剩余问题、谁接着处理什么、是否已经安排；无后续也写明 |
| userAction | 用户具体需要提供的信息或决定；没有依赖时明确写“无需操作” |

新提示要求 explanation 和其中的 note；已接纳的旧提示仍允许省略，兼容读写但不补造说明。不适用须保持 checks 为空、缺项计数为零。通过或修复后通过不能夹带失败／未知检查项；已存在的真实附件可以完成验收。回执验证引用存在及字段结构，不替代语义验收，也不把 Agent 自报当作人的确认。记录失败不阻塞交付，不触发重复发送或自动续跑。

当前 Codex App Server 提供阶段计量。其他 Harness、计数器重置、缺少起止采样或未结束的执行显示未知，不能补零，也不能把整轮用量归给自检。阶段用量包括上下文及 finish 工具编排，begin 之前和 finish 返回后的最终答复未计入；它不是“开启相对于关闭”的净增成本。不增加独立审查模型；每次正常回报需要 begin、finish 及取证工具，真实代价见验证记录。保留未开始／未结束／不适用的分母，不能只用成功回执计算功能成功率。

新接纳的交付自检 v2 工作只对实际执行成果保存核对回执；无额外交付验收的普通讨论、简短问答不再为 `not_applicable` 发起工具调用。此类输入可能显示 `no_record`，不能把该计数当成漏验收率。旧 v1 工作保留原规则与回执要求。

确定性验证：`tests/test-feature-observation.mjs`；真实模型隔离验证：`REMOTELAB_LIVE_FEATURE_OBSERVATION=1 node tests/test-feature-observation-live.mjs`。两者不写生产配置、不发飞书消息。

Monitor Overview (`?tab=tasks&monitor=overview`) displays running/active Session counts, all seven daily metrics and seven-day charts, the timing breakdown, context sources and account balances directly on the page. There is no summary-only card or details drawer. The day boundary is stated once above the charts (Beijing time, 05:00). Daily sample tables and statistical definitions remain available beside their data; context sources start expanded and refresh preserves the reader’s choice. Account quotas and reset times share one table, replacing the duplicate expandable account cards.

The former Test preview has been retired after its MukaHub migration; old `monitor=test` bookmarks resolve to Overview without loading a second dashboard. Shared metric collection and Hub snapshot export are retained.

Usage analysis remains a separate view for period/Session filters and execution, delivery and usage breakdowns. Its selected observation interval is distinct from the Overview’s fixed business day. Automations, feedback and **Prompt 安全** retain their separate views and controls. Removing the Test UI does not stop observers, alerts, recovery or external synchronization.

## Prompt 安全审阅

可交给实例 Agent 的启用请求：

> 请为当前实例启用监控器里的 Prompt 安全审阅。核对实际源码、配置目录、已登录 Codex 账号和已安装 Pi，先跑隔离测试及一小批真实 Luna 审阅，读取实际用量和失败。对所有可取回历史做首轮批审，按指纹去重，再用当前原生 Schedule 的脚本条件定期调用 `scripts/prompt-review.mjs --launch` 补审。条件返回 false，不另起会话 Agent、不发送消息。记录任务 ID 到配置并验证自然执行、认证入口、脱敏来源、服务版本和覆盖缺口。只报告风险与建议，不修改被审文本或执行整改。

一次交接需要目标实例和是否允许使用其现有模型账号；如没有已登录账号或 Pi 安装，必须先补齐该依赖。不要把“低成本”理解成零计费。入口为 **监控器 → Prompt 安全**；筛选风险级别、审阅状态和分页，打开条目看证据、建议、脱敏原文及原会话。刷新页面只读持久化结果；“补审待处理内容”在已启用实例启动有界后台批处理。用户不需要手工复制运行命令。

统一监管页的 **安全 → Prompt 审阅** 现在直接复用上述认证接口展示风险明细。
总览的三个 Prompt 卡片均在二级抽屉直接提供信息：完整审阅展示覆盖、未完成片段、
风险分布和累计 Token；风险抽屉直接列出原话、原因与建议；规则接收展示状态计数、
最近版本记录和查询覆盖。完整原文或审阅管理等较少使用的材料再沿详细入口查看。
风险明细默认查看严重与高两个级别，提供“最新优先”“严重优先”，可切换等级和翻页。
时间指审阅时间，不能当作任务发生时间；严重优先时同级按审阅时间降序，未知时间置后。
接口按完整筛选结果排序后再分页，刷新保留选择，不只重新排列当前页。
每条保留模型原因、建议、审阅日期、示例来源和原会话链接；高风险证据标红，
点击上下文后才读取经指纹校验的脱敏原文，并标出命中行。原文变化或不可取回时
显示缺口。公开页面仅展示汇总及登录入口，风险原话不写入公开快照。
页面刷新只读既有结果，不启动补审。关联来源数不是独立事件数；处置状态尚未
关联，历史模型标记不能当作当前事故或已确认违规。展示沿用 token，不换算金额。
客户端组件维护在 `static/chat/monitoring-prompt-risks.js`，样式在同目录同名 CSS。

### 来源和覆盖口径

- 扫描本实例全部 `chat-runs/run_*/manifest.json` 的 `prompt`，及尚未包含在该文本中的 `modelContext`。这是实际运行准备保存的提交文本，不能单凭保存记录证明 provider 已接受。
- 读取 `native-inputs` 的提交指纹原文，区分 accepted 和 uncertain；明确拒绝的输入不算已提交来源。这补齐原生会话后续输入，避免只看 Run 首次 manifest。
- 启用后捕获普通后台分类和记忆辅助调用的准备文本到私有 `CONFIG_DIR/prompt-captures/`。捕获失败保留缺口并写通用日志；历史未保存的后台文本无法补造。
- 以标题和最多 12,000 字符分段，保留每个字符和原文起始行。精确 SHA-256 指纹复用相同内容段的审阅；只有一个来源的每个段都审完，才计入“完整审完”。规则原文哈希、规则版本及模型共同隔离结果命名空间，改规则后重新审。
- 缺失、超出单源 4 MiB 读取上限、JSON 错误、漏返回、证据行无效、模型失败都保留为缺口或失败；没有结果不计通过。失败按 15/30 分钟退避，最多三次，之后保留供排查。原文变化后旧证据入口拒绝展示，等待新指纹补审。

**这不是完整 provider 请求审计。** Harness 自行加载的 AGENTS/Skill、工具返回、内置系统指令、附件二进制、压缩后上下文和未留存的历史后台提示目前无法全量取回，其数量未知。分段覆盖表示所有可取回内容都经过审阅，跨段组合、真实授权和实际执行后果仍须结合原会话核查。“未发现具体风险”只描述本段结果，不提供安全保证。

### 模型、Token 与运行

固定审阅指令在 `chat/prompt-review-policy.mjs`，检查提示注入、越权与权限扩大、秘密外传、破坏性动作及第三方影响。审阅文本始终作为不可信 JSON 数据；通过现有 Codex 账号池及 Pi `openai-codex/gpt-6-luna` / low 路由调用，明确禁用所有工具、扩展、Skill、上下文文件、模板和会话保存，在私有临时目录运行，不执行整改。没有该安装或可用凭据时显示失败，不升级昂贵模型或切换其他账号身份来掩盖缺口。现有 Codex 登录需保持有效。

响应必须逐段给出结构化结果；风险条目有严重度、类别、证据行、原因和建议。证据由服务器从原文行提取；常见凭据、鉴权头、长 token 和敏感查询参数脱敏，模型自由文本也经过脱敏。认证接口不接受任意文件路径，不把原文或模型错误原样放进日志。原会话仍沿既有共享实例认证访问。

模型风险线索尚未经过人工确认，不代表已经发生执行或泄露。脱敏同时移除原文中可识别的凭据值，防止模型在自由说明中脱离字段名重复短凭据；私钥块脱敏保留原文行数。provider 错误附带的全零占位用量计为缺回执，不能算成已测得零消耗。

私有配置 `CONFIG_DIR/prompt-review.json` 默认不存在即关闭：

```json
{
  "enabled": true,
  "concurrency": 2,
  "maxBatches": 30,
  "batchChars": 180000,
  "batchItems": 40,
  "scheduleId": "the-existing-native-schedule-id"
}
```

并发限制 1–4，每批最多 300,000 字符/100 段，每次工作进程最多 1,000 批。`scripts/prompt-review.mjs` 执行一轮；`--launch` 脱离 HTTP 请求启动有限工作进程，原生 Schedule 的脚本条件可调用它后返回 false；`--status` 读状态。Schedule 需要显式携带本实例配置目录与 provider home，不能继承其他实例的存储。不要另建调度器、公开页面或消息推送。工作锁阻止同实例并发批审，进程退出后的下轮从持久结果恢复。

结果、调用回执、进度在私有 `CONFIG_DIR/prompt-review/<规则指纹>/`；旧版本保留。每次调用记录实际模型、规则版本/哈希、provider response ID、实测输入/缓存/输出 token 与耗时，失败回执亦保留。既有 usage ledger 使用 `prompt_security_review` 操作归因。页面只展示实际 token、调用数与回执覆盖，不展示换算金额；缺回执不能算作零消耗。后端旧估算字段仅为既有接口兼容保留。

接口沿用实例认证和全员共享权限：`GET /api/monitoring/prompt-review`（`severity` 支持逗号分隔多级，`sort=severity|time`，状态筛选与分页）、`GET /api/monitoring/prompt-review/source?id=...`（指纹校验的脱敏原文）、`POST /api/monitoring/prompt-review/run`（同站启动已启用审阅）。验收用 `npm run test:prompt-review`；部署后仍需读真实首轮与增量任务回执。关闭配置可阻止下一次启动；已有进程会完成本轮有限批次。

## Account balances and Token total

Account tables show observed remaining quota in each independent allowance window, observation time, and expandable reset details. Unknown quotas remain unknown; meters never combine separate windows. Automatic-switch policy and operational handling prose are omitted from this balance view.

The separate bottom Token-total section has been removed. Token statistics remain
in the Session dashboard: daily total and average usage with seven-day trends.
Account collection and the usage-analysis view are unchanged.

Session's seven daily/weekly charts are defined in the Agent dashboard section below. They share the existing usage read and do not add model calls, timers or quota probes. The group panel also reads bounded projections of the existing connector inbox, participation state and delivery records. Refresh preserves disclosure choices; missing data is not interpreted as zero.

## Session changes and automatic diagnosis

Session metric changes are neutral statistical clues, separate from the actual
running/idle state. The row disclosure holds ratios, evidence and diagnosis
history; opening/closing it survives data refresh. A longer task or larger
cumulative input alone is not a fault and does not start a diagnosis.

Opt in with `sessionDiagnostics.enabled: true` in `monitoring.json`. The existing
minute observer runs the bounded local analysis at most once per five minutes;
opening the page never starts it. No new timer or model call is created.
`node scripts/session-diagnose.mjs --dry-run` previews candidates without state
writes, sends or recovery admission.

The original stage detector compares the same Session/model/Harness: three newest distinct
foreground Runs against 10–20 prior samples from the last seven days. Preparation
(including queue time) or launch must reach both 15 seconds and three times the
baseline median in all three Runs within 30 minutes. Three Sessions with a latest
qualifying sample within ten minutes also trigger a shared stage investigation.
Missing timestamps, background work, archived Sessions and duplicate Run IDs do
not qualify. Without the optional metric-review extension below, execution duration, context
and cumulative input remain display-only clues. With it enabled, context and
end-to-end response/delivery changes trigger evidence-qualified human review,
not automatic claims of failure.

The fixed diagnostic records stage, sample evidence, simultaneous service/disk/
account risks and links to existing recovery records. It distinguishes correlation
from a proven cause. It does not restart services, alter queues, modify prompts or
admit an additional model worker. Preparation substeps, active tool progress and
per-call input attribution remain gaps; unexplained cases say so explicitly.

One stage/model/Harness incident combines up to 20 affected Sessions; one new
analysis is admitted per observation. Unchanged evidence never reruns; changed
evidence has a 30-minute cooldown. The original incident stays open without new
traffic. Recovery requires three newer successful Runs below 80% of the original
threshold for each recorded member; natural recovery is not labelled a repair.
Retain at most 100 incidents, pruning resolved entries first; a full unresolved
store admits no additional incidents. Sampling is bounded to 1,000 recorded Runs
and 64 MiB per collection without reading prompt manifests. Coverage limits are
reported rather than treated as healthy samples.

Private trial delivery is configured separately:

```json
{
  "sessionDiagnostics": {
    "enabled": true,
    "notification": {
      "enabled": true,
      "profile": "approved-bot-profile",
      "configDir": "/path/to/existing/lark-config",
      "feishuAppId": "cli_approved_app",
      "openId": "ou_approved_recipient",
      "overviewUrl": "https://instance.example/?tab=tasks&monitor=overview"
    }
  }
}
```

Resolve the recipient from the same Bot's verified source identity. Group IDs are
rejected and the general monitoring group is never a fallback. A paused general
alert route remains paused. Cards contain stage/count and diagnostic conclusions,
not conversation titles or message contents. Each incident gets one private card;
changed conclusions and recovery edit it after verifying the original Bot and
chat. A recipient/profile change never redirects an old card. One notification
operation is allowed per observation by default; the optional extension allows three. Write intent is durable before external
I/O; uncertain sends or edits require receipt inspection, not automatic replay.
The authenticated page shows delivery uncertainty in the affected row. The first
version reports completed fixed analysis and waits for new evidence; it never
claims a model is working or displays a nonfunctional approval button.

### Private trial with fewer interruptions

Set `sessionDiagnostics.notification.noisePolicy.mode` to `risk_only` to separate
local diagnosis from private delivery. This is an opt-in policy; it does not
enable diagnosis or notification. Both existing `enabled` switches retain their
meaning, and publishing code never resumes a paused trial.

Normal account switches share one local observation with bounded source
references. Statistical changes remain local investigation clues, without asking
the recipient to explain normal task variation. Resource-repair results retain
their original resource notification route rather than generating private copies.
The account ledger and old private-message receipts remain intact.

An account-continuity incident qualifies only when a recent (30-minute) running,
queued or failed request still references the unavailable bound account and
automatic switching is disabled or no available backup is known. Unknown backup
quota is a collection gap, not proof of exhaustion. Three distinct fresh
observations of the same actionable condition are required. Re-reading one quota
snapshot, incomplete collection, idle bindings and routine switches do not
satisfy this gate. A failed request is not attributed to account exhaustion merely
because both were observed.
A later successful foreground retry supersedes an earlier failure even when both
share the same original request timestamp; background helpers do not replace it.
An older request completing late does not supersede a newer request's failure.

One continuity incident retains its message ID. A changed decision, an available
fallback, or independently verified recovery can update that message; counts and
sample fluctuations do not. An available fallback is described as readiness for
subsequent execution, not as completed business work. Disappearance from recent
traffic is not recovery. Uncertain delivery remains blocked for receipt review.
The private card has three short lines: the risk, what was actually checked, and
the specific next action. It omits changing counts and retains detailed evidence
in the existing diagnostic ledger. It does not present a navigation link as an
approval button.

On first adoption, existing incidents become the known baseline without changing
their receipts. During notification mute, observations also become the baseline.
Resuming does not drain old messages into a backlog; a new actionable condition
or a verified recovery followed by recurrence must qualify again. This policy
adds no timer, model worker, account switch or automatic business retry.
`scripts/session-diagnose.mjs --dry-run` includes candidate notification reasons;
it performs no sends or writes. Qualification in that preview is distinct from
actual delivery, which also checks the baseline, confirmations and mute state.

## Routine task health reads

The overview and independent minute observer use `readAutomationHealth`, not the
full automation browser projection. They keep all task identities, current
schedule/gate state and latest execution, including paused/cancelled tasks needed
for recovery attribution and unknown admissions. Recurring tasks resolve only
the latest occurrence (same stable timestamp ordering as the browser). One-time
tasks retain their existing Run/Request receipt fallback. No age cutoff silently
removes a task or substitutes a success for missing evidence.

Each collection shares pending Run/receipt lookups by Run ID, limits resolution
to 16 concurrent workers, and omits ownership/Session enrichment, prompts,
package lineage and full-history statistics. The cache ends with that collection;
late state corrections and recovery are read again next time. Source errors still
produce coverage gaps. Task-browser history, alert/recovery policy, timer cadence,
nightly review, evaluation reports and message context are unchanged. API log
scanning and historical recovery-log verbosity are separate remaining costs.

## Activate on an instance

Give the instance's coding agent this prompt, with the instance URL and approved sources and alert recipient:

> Enable Monitoring for this instance. Inspect its configuration directory, service user, account observer and report workflow. Connect only the supplied fleet state, disks and owned services in monitoring.json. Keep credentials and quota RPCs outside page requests. Merge routine observations into our existing daily report, preserving its source, comments, permissions and delivery. If urgent alerts are authorized, provision one independent no-model observer using scripts/monitoring-alerts.mjs, establish the known-incident baseline, and verify its service, timer and durable delivery state. Do not create another routine group report or separately maintained dashboard.

Existing connected accounts need no additional sign-in. Missing sources remain visible as gaps. New account authorization and external recipients must come from the operator; the feature does not infer either.

Optional instance-local `CONFIG_DIR/monitoring.json`:

```json
{
  "fleetStateFile": "/path/to/fleet/var/adapter-state.json",
  "autoRequestStateFile": "/path/to/fleet/var/auto-nudge-state.json",
  "disks": [
    { "path": "/", "label": "System disk", "system": true },
    { "path": "/data", "label": "Data disk" }
  ],
  "services": [
    { "unit": "owned-app.service", "scope": "system", "label": "Workbench" },
    { "unit": "owned-observer.service", "scope": "user", "label": "Account observer" }
  ],
  "criticalAutomationIds": ["sch_important_job"],
  "alertDelivery": {
    "profile": "approved-bot-profile",
    "configDir": "/path/to/lark-config",
    "chatId": "oc_approved_group",
    "ignoreUnits": ["own-observer.service", "own-observer.timer"],
    "overviewUrl": "https://instance.example/?tab=tasks&monitor=overview"
  }
}
```

Connect only explicit owned units, not unrelated users' services. Scope is `system` or `user`; only fixed service/timer names are accepted. Without configuration the overview still shows the local ledger, cached runtime accounts, native automations and root disk, without claiming fleet or independent-service coverage.

## Observation contract

### Responsibilities

Monitoring owns fixed-resource and execution health: account allowance, usage,
disk capacity, configured services, API dependencies and whether enabled
automations actually execute. Project review owns the interpretation of project
discussions and the creation/update of project Todos. The existing daily report
combines project changes, existing Todo changes and a monitoring snapshot; it is
a publication view, not another Todo generator. A project-review schedule shown
on Automations is supervised as a running job, not as project content.

On this instance the four project-group Todo scans remain independent jobs;
their group notifications were removed and useful changes feed the existing
reports. Consolidating publication does not establish that source reading is
shared or duplicate scans eliminated. Preserve the original scan cursors,
authorization, task list and private-review route when integrating those inputs.

Before classifying an automation failure, inspect its current lifecycle and
enabled flag. Paused, cancelled, finished or disabled tasks are not new runtime
faults and cannot authorize automatic resumption. A skipped condition is not a
failed execution: for example, an enabled scheduler with `consumer_disabled`
is checking a deliberately disabled business consumer. The schedule's switch,
business switch, Run outcome and result delivery have distinct meanings.

`GET /api/monitoring/overview?days=1|7|30` uses existing authentication and shared-instance rights. Partial failures preserve the remaining observations. Same-window requests coalesce for 15 seconds. The page refreshes when opened, explicitly refreshed, its period changes or it returns to visibility. There is no model call or periodic browser poll.

- Consumption comes from the instance ledger, with foreground/background work, cached tokens, daily trend and models. The rolling window is explicitly dated. Interface-reported costs and token-price estimates are separate; estimates are not subscription bills.
- Cached runtime and optional schema-v2 fleet observations are deduplicated by provider identity. Only ready samples within ten minutes qualify. Conflicting, stale, expired or missing observations stay unknown; a fresh source can replace a paused one. Any exhausted window makes an account unavailable, even if weekly allowance is full. Email labels are masked; credentials and raw source errors are not returned.
- Storage includes bytes and inodes. Root warns below 15 GiB or at 85% use and is critical below 8 GiB or at 92%. Percentage thresholds also apply to other disks and inodes. Paths sharing a filesystem are marked, never added together.
- Execution health includes recurring tasks, current one-time work and recent failed one-time work, plus configured independent services/timers. A successful inactive oneshot is healthy; a never-run oneshot is unknown. Execution success does not prove delivery. Existing task controls and Session records remain authoritative.
- Fixed allowance-check requests retain their receipts and are not project output. Available capacity suggests choosing useful existing work; it is neither evidence of waste nor permission to start arbitrary work.

## Reports and urgent alerts

### Feishu API dependency

Enable `feishuApi.enabled` in the same `monitoring.json` to observe the existing
`feishu-api-logs/` ledger. Supply `apps: [{appId, label}]` and optionally
`callsPer5m` (default 100). This uses the existing minute observer, Overview
and daily-report source; it creates no probe, model task or additional timer.
Each app shows observed calls/failures in a rolling 24-hour window, recent
traffic, latency and the busiest sanitized endpoints. The first observation
date is retained: a window with only a few hours of logs is not a full-day
measurement. Direct CLI requests, other instances and billing eligibility
remain explicit gaps. Reads are bounded to 31 days, 512 files and 32 MiB;
truncation or malformed logs cannot establish healthy coverage.

Component and hourly breakdowns distinguish chat/comments, progress cards and
display reminders. Upgraded successful GETs compare request and data digests
made with a random process-local HMAC key; no resource IDs, query values,
responses, authentication data or payload hashes for writes are logged.
Twenty identical successful reads in five minutes flag possible polling waste
for the report. This is a design-review clue, not proof that a business request
was redundant, and comparison across processes or old logs is not inferred.
An operator-confirmed `tenantQuotaLimit` can retain the monthly ceiling without
inventing the used count. Remaining allowance and early budget warnings still
require the independent fresh administrator measurement below.

Monthly rejection `99991403` is an immediate critical incident, latched in
`feishu-api-health.json`. Token success, idle traffic, log retention and
restarts cannot clear it. After an administrator restores quota, independently
verify a previously affected interface, then record `quotaRestoredAt` and
`quotaRestorationEvidence` in the same configuration. A later rejection
blocks it again. Rate spikes (100 calls in five minutes by default), at least
five failures with a 20% failure share, or at least five calls taking five
seconds with a 20% slow share use the existing confirmation count. The
threshold is an initial operational setting, not a measured billing budget.

True tenant quota is separate. An optional `tenantQuota` contains `used`,
`limit`, `observedAt`, `source: "feishu_admin"` and an evidence reference from
the administrator's Billing / My Quota page. Only readings within 24 hours
qualify; 80% is a report warning and 90% triggers the unified critical route.
Local call counts never substitute for tenant billing. Without a fresh
administrator measurement the remaining allowance is unknown. Feishu's
[official quota notice](https://open.feishu.cn/document/platform-notices/platform-updates-/custom-app-api-call-limit)
also describes its native 90% and 100% notifications to administrators and
developers. Check these in the existing authorized administrator workflow;
this instance does not claim to have read or configured that console.

When the provider has rejected monthly quota, the observer persists new
notification intent as `blocked_dependency` without trying to send through
that same provider or changing Bot. Overview and the report expose blocked
and uncertain alert batches. Existing uncertain sends still need readback;
no automatic replay is permitted. Local observation continues even while
Feishu delivery is unavailable. This is visible in Web, not a claim that an
independent phone/email notification was delivered.

### Explicit service pauses and historical repairs

A configured service may carry `maintenance: {reason, source}` citing the
actual operator pause. Only an inactive service is then shown as paused;
failed, missing and starting states retain their normal meaning. This avoids
new repair admission for intentionally stopped components without deleting
their state. Remove the maintenance annotation after the original operator
scope permits resumption, and verify the real service and business result.

Recovery rows include `currentResourceStatus` from the fresh disk/service
measurement or current automation lifecycle. Healthy, intentionally paused,
cancelled and finished objects leave the Overview's current-problem area;
records remain under collapsed history and in the JSON/ledger. The daily source
shows current repairs and a historical count, rather than repeating old errors.
A later successful Run clears an older failure from current execution health;
it does not retroactively prove an old repair's product or delivery acceptance.
Missing task sources remain unknown and cannot establish recovery.

`scripts/monitoring-report.mjs --output <prefix> --base-url <instance> --days 1` writes local JSON and a compact Markdown section. It publishes and sends nothing. The established daily workflow reads this source, incorporates actual maintenance and gaps, commits its Markdown and reuses its publisher and group delivery. No separate routine message or Base is needed.

When a visual snapshot is authorized, enable the optional browser capability in the same instance configuration:

```json
{
  "snapshot": {
    "playwrightModule": "/path/to/installed/playwright/index.mjs",
    "browserExecutable": "/path/to/chromium",
    "profile": "approved-daily-bot",
    "cliConfigDir": "/path/to/lark-config",
    "overviewUrl": "https://instance.example/?tab=tasks&monitor=overview"
  }
}
```

Use `scripts/monitoring-snapshot.mjs --output <prefix> --base-url <instance> --days 1 --upload` before the existing daily reply. It captures only the top issues and account cards from the shipped authenticated UI, at twice the display resolution. The PNG and source JSON share one observation. The service token stays in-process and is forwarded only to the selected instance origin. Optional `libraryPath` and `noSandbox` support a host's existing browser installation; no new runtime dependency is imposed on the workbench.

`--upload` uploads as the explicitly configured Bot and writes a Markdown image-key block plus a receipt; it does not send. Include that block in the existing daily summary. The Feishu converter embeds a standalone `![label](img_key)` as a native image in that same post. It does not fetch remote URLs or local paths, and fenced examples stay literal. Keep the full editable table in the original report. Capture or upload failures must be reported as a snapshot gap and retain the ordinary daily text, not reuse an older image as today's observation.

An optional independent `scripts/monitoring-alerts.mjs` observer needs no HTTP server or model. Run it under one user service/timer with an explicit instance environment. It batches newly actionable disk/service incidents and important native task failures persisting for three observations into shared, updateable Feishu cards. Normal account exhaustion stays in the account table; actionable local backup/switching failures use the continuity route below. Normal, restored and lower-priority states go into the report.

### One incident, one message

An unresolved incident keeps its original message ID. Starting recovery, switching models, changing a plan, reaching a worse disk risk stage or completing verification edits that message rather than sending another one. Minor disk-byte fluctuations do not trigger edits. Batch updates preserve the other subjects in the original message, including their recovery results. Only explicit healthy evidence followed by a new failure starts a new incident and message.

Cards show current risk, actions actually reported, their outcome, the specific next decision, and a link to the original recovery Session. Critical risk and pending human decisions are red; the observation time is secondary text. A running attempt cannot display an older attempt's summary as work it has just completed. Normal account exhaustion remains silent; a local lack of qualified backups or a disabled/failing switch is a continuity risk, not a request to fix normal consumption.

Set `alertDelivery.enabled` to `false` to mute both sends and message edits while keeping the existing observer, snapshot collection and authorized recovery running. `recovery.enabled` remains a separate control. Do not stop the combined timer just to silence notifications. Unmuting reuses existing message IDs; use the existing baseline mode to acknowledge known unmessaged incidents when appropriate. A later real escalation or a new concrete confirmation plan can notify a baselined incident once.

New messages use shared cards (`update_multi: true`); existing rich-text notifications are edited in place without changing their IDs. Edits use Feishu's original-message APIs and their platform limits. An unavailable/recalled/expired message, a changed recipient, an interrupted edit or uncertain acknowledgement is retained as `needs_review`; none permits creating a replacement message automatically. Keep recalled receipts as audit, explicitly reconcile them before resuming, and never clear the ledger to retry a send. Existing card updates: https://open.feishu.cn/document/server-docs/im-v1/message-card/patch ; legacy message edits: https://open.feishu.cn/document/server-docs/im-v1/message/update .

Keep the observer's own service and timer visible in Overview, but list them in `alertDelivery.ignoreUnits`: it cannot reliably supervise its own absence, and an explicit maintenance pause must not notify as a new outage. Their health remains inspectable from the application and daily report.

To consolidate account and resource notifications, set `alertDelivery.accountAlerts` to `{ "enabled": true, "sources": ["approved-adapter-id"] }` and `alertDelivery.confirmationObservations` to `3`. The same observer then batches local account-continuity risks, service failures and resource incidents in one message and one durable delivery ledger. Account readings use the existing identity deduplication across sources; one unavailable adapter does not report a loss when another source has a fresh valid reading. Account-continuity incidents require at least three observations. Services use the configured confirmation count (1–10, default 1); disk emergencies remain immediate. A baseline acknowledges existing account and service incidents even before they reach the confirmation count. Unknown readings never rearm an exhausted-account incident. Turn off the account dashboard's separate notification recipient before enabling this route, retain its collection and history, and verify that the old observer/timer is stopped on the retired host. Keep routine observations in the existing report.

During migration, `--baseline` records already-known critical incidents without repeating a group notification. Recovery rearms a recurrence; unreadable sources cannot establish recovery. The observer persists sending intent before delivery, then saves the shared verified message receipt. Interrupted or uncertain delivery becomes `needs_review` and requires readback before retrying. Preserve state across restarts. This observer does not replace task result delivery.

Before resuming after a task-source change, verify that all configured important native task IDs still resolve. Missing IDs are coverage gaps, not recovered incidents. A missing item, an unavailable read or an unfinished retry cannot rearm an already reported failure; an explicit healthy observation or stopped task is required. Names and page groups do not change incident identity. Important tasks still require three failed observations before a new alert.

Use `scripts/monitoring-alerts.mjs --dry-run` against the target instance environment to preview eligible notifications without sending or changing durable observer state. Once the current problems have been reviewed, run `--baseline` with the timer stopped, then enable the existing timer and verify its natural execution. The baseline also acknowledges existing important-task failures before they reach three observations, while preserving previous sending receipts. Known problems remain visible in Overview and the report; a later verified recovery allows a new failure to alert again.

## Recovery after a failure

When the operator authorizes recovery, extend the same observer instead of adding another timer. Observation, incident notification and repair have separate durable records. Reporting or baselining a problem does not resolve it. The Harness still diagnoses the error, chooses permitted work and verifies business results; this broker supplies incident identity, bounds, admission and receipt reconciliation.

Service recovery inherits `alertDelivery.confirmationObservations`, so a brief restart cannot start a repair before the configured number of distinct failed snapshots. Counts survive observer restarts and reset after an explicit healthy observation. An unknown measurement cannot authorize a new service repair. Disk warning investigations and emergencies remain immediate, and already admitted work continues normal receipt reconciliation.

Add an explicit instance-local configuration:

```json
{
  "recovery": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:INSTANCE_PORT",
    "coordinatorSessionId": "EXISTING_AUTHORIZED_OPERATIONS_SESSION",
    "automationIds": ["*"],
    "maxAttempts": 2,
    "maxConcurrent": 1,
    "models": ["gpt-6-sol", "gpt-5.6-sol"],
    "workflowPaths": {"disk:/": "/path/to/current/authorized/disk/WORKFLOW.md"}
  }
}
```

The default automation scope is native task failures with an actual failed Run. Use a list of task IDs to narrow it; `*` covers all such tasks. Paused, cancelled, completed, superseded or archived work is not restarted. Configured critical disk/service incidents use the existing coordinator Session; a busy coordinator is deferred. Account observation remains with its own observer. A gate failure without an admitted Run remains an alert/coverage issue and does not authorize bypassing the gate.

`monitoring-recovery.json` retains each failure and its attempts through observer restarts. A current manual continuation is observed before any new work; after it ends, a bounded verification turn checks existing results. New recovery work resumes the original task Session and its original delivery route. It keeps successful inputs, comment anchors, task scope and business-write receipts, patches the actual Session model before admission, then reads back the Run model. It restores the prior preference after the attempt, preserving an intervening user change. Lost admission acknowledgements are read back and reconciled using one native request ID. They never authorize replaying an uncertain business write or message.

Each repair writes a keyed acceptance receipt under `monitoring-recovery-receipts/`. Provider completion alone leaves the incident pending verification. Task evidence and acceptance are required; disk/service recovery also requires a fresh independent healthy measurement. Conversation delivery requires the original final source-delivery receipt, not an opening message; uncertain delivery is observed for up to ten minutes without resending, then remains blocked. Permission, ownership, external dependencies or exhausted attempts retain a concrete reason rather than silently disappearing. Current phases and results are visible in the existing Overview and daily report.

Use `--dry-run` to inspect pending recovery without saving state, admitting work or sending. Enable on the intended instance only, check current in-flight/manual work, then observe the existing timer's first real receipt. The observer can still discover and report outages when HTTP/model access is unavailable; AI repair waits for a usable native admission path. One observer process owns this ledger; do not launch a second concurrent observer against it.

## Verification

Recovery, delayed publication and acceptance replies do not inherit a scheduled report's all-member mention. The recovery prompt explicitly overrides that scheduled rule; use a full-group mention only when the user requests it for this recovery.

A confirmation receipt requires concrete steps, target, impact, rollback and verification, plus evidence. A flat target object containing identifiers is normalized into readable text without approving the plan. Malformed confirmation receipts remain in verification, preserving real completed actions, and can be corrected in place without another model run. The former exact “missing confirmation plan” formatting block is also re-read for compatibility. Other business or authorization blocks remain blocked.

Final delivery acceptance reads the original durable Request aggregate, including archived Requests; absence from the active outbox is not a delivery failure.

`npm run test:monitoring` covers account freshness/deduplication, partial reads, shared filesystems, incident/recovery behavior, bounded model changes, lost admission acknowledgement, manual recovery adoption, independent acceptance and delivery reconciliation, report boundaries, UI defaults and authenticated HTTP access. Run the relevant isolated checks locally before main delivery, then verify real desktop/mobile views, unchanged automation controls, source coverage and timer execution on the target instance. Saved schedules or passing tests do not establish that a future report reached its group.


## Automation responsibilities and shared inputs

Operator handoff: “Classify this instance's automation by its actual purpose, verify native and business switches, and combine repeated project inspection inputs before publishing. Preserve original source permissions, task cursors, write locks, delivery routes and paused projects. Verify configuration separately from the next real execution.”

Recurring schedules accept optional `purpose`: `operations`, `projects`, `research`, `execution`, `memory`, `improvement`, or `other`. These describe operations and monitoring, project progress, news/research materials, business execution, collaboration memory, and feedback/improvement. Purpose is persisted and projected into the existing automation view; editing it does not alter cadence or delivery. Unclassified legacy titles retain an explicit fallback. Long instructions are not classification inputs.

A fresh business condition distinguishes disabled execution, waiting for a useful condition, and a report held after uncertain delivery or exhausted retries. Native schedule state, exact execution history and delivery evidence remain independent. A stale or failed condition read does not assert that business execution is disabled.

`automation-background.json` in the instance config directory can register display-only descriptors under `mechanisms`. Each has `id`, `title`, `purpose`, `trigger`, `note` and a `source`. Supported sources are an exact `systemd` unit, an `environment` flag, a `json_flag`, a read-only `sqlite_scheduler` flag, or an `embedded` mechanism. `/api/automation-tasks` returns these as `backgroundMechanisms`, separately from task records and execution counts. Reading descriptors starts no job, sends no message and makes no provider request. Missing or failed source reads remain unknown; configured mechanisms do not claim completed execution.

For a shared project inspection, `scripts/project-inspection-plan.mjs` takes the current project runtime, original Todo registry, review root and original scheduled timestamp. Its read-only plan merges the earliest source/Todo cursor with a 48-hour overlap and both known-thread indexes. Pending retries keep a morning target eligible even when its success cursor has reached the scheduled boundary; their thread and source-message IDs remain in the plan so older failures cannot disappear. Paused projects and unauthorized targets stay excluded; missing baselines require full initial reading. An instance-authorized `personTodoExpansion` can add full Todo reads across its registered focused/overview groups while retaining per-person registration scope and the original project-analysis boundary. See [Todo judgment and personal views](todo-judgment.md) for collection, semantic evidence and projection. The morning phase assesses the planned Todo targets before publication; the afternoon phase reuses their latest result. Real collection, understanding, task writes and successful cursor advancement remain the Harness's original workflow, not the planner's side effect. Keep actual task writes under the existing lock and reread relevant state to handle concurrent writers.

Before recording a successful Todo scan, ask the Harness to run `scripts/check-todo-coverage.mjs --plan <inspection-plan.json> --target <key> --index <source-index.json> --judgments <target-judgments.json> --output <coverage.json>`. It compares the planned window's human message IDs and required retry IDs with the collected source and the Harness's action judgments, returning a nonzero exit code for omissions, mismatched chat scope, invalid source times, missing reasons or unknown source references. A source index has `chat_id` and `messages` (array or ID map); each message includes `message_id`, `create_time` and `sender.sender_type`. Collector wall times without a zone use Asia/Shanghai. Target judgments contain `actions`, each with `sourceMessageIds`, `disposition` and a nonempty `reason`, including no-action decisions. Split shared judgments by their actual source target before checking; never restrict them to a shorter window. The output is coverage evidence only: successful pagination, semantic decisions, completion evidence, task write/readback and notification authorization still require the original workflow. The checker does not create tasks, publish messages, advance cursors or act as a model-based reviewer.

`scripts/research-candidate-handoff.mjs` exports deduplicated public original links from a source-candidate snapshot. It preserves capture editions, review status and the original source hash, excludes private references/internal links/credentials, and performs no collection or dataset admission. The existing dataset workflow consumes this input first, reuses evidence and probes only missing discovery coverage and its distinct license/payload/catalog requirements. Export time cannot make old material fresh, and a captured link does not prove original reading or dataset eligibility.

The next natural source read, task readback, report publication and delivery each need their own evidence after consolidation. A passing planner test or a saved schedule is not that acceptance.


## Read-only Session monitoring

`/?tab=tasks&monitor=overview` is the native authenticated monitoring view.
The former `static/monitoring-live/` entry redirects here and contains no instance
records. Monitoring panels use the existing login and only GET queries. Session ownership comes from the canonical external conversation binding
and `initiatedByIdentityId`, joined to People; personal sidebar folders are not
source chats and later participants do not become Session initiators. Unknown
ownership stays explicit. Shared accounts, storage and services remain instance
resources; this page reuses Overview's observations, attention and thresholds.

`GET /api/monitoring/sessions?days=1|7|30` returns narrow ownership and measurement
projections plus the existing deduplicated usage summary. It uses a 60-second
per-window single-flight cache and reuses unchanged projected files by file
version. It never invokes a Run reconciler, notification or recovery operation.
Stage measurements read only the most recent 1,000 ledger Run references and their
Request/Run metadata, in batches of eight, with a 64 MiB cold-read budget and a
2 MiB per-record limit. Coverage reports sample counts, limits, missing records,
errors and generation time. Parsed request text, deliveries' bodies and runtime
secrets never enter the response or projection cache. This does not backfill all
history or instrument each model call. Full Session usage aggregates and bounded
stage samples have separate coverage.

Run measurements merge the base status with sparse execution and recovery shards.
Projection retains only fields present in each shard, so absent shard identities or
timestamps cannot erase the base Run/Request association. This also preserves
manifest size measurements and current-day dashboard samples after split-state runs.

Each stage has its own paired sample count: accepted→prepared includes queuing,
prepared→started covers launch, started→completed includes explicit waits, and
settled→all final content parts delivered covers final transport. Requests
steered into an existing Run do not manufacture additional Run samples. Foreground
context is the mean of each Run's latest reported context; per-Run accumulated
input is separately named. Neither is the mean of every model invocation.

Page-only deviations compare the same Session, model and Harness: recent three
foreground samples against the preceding up to twenty (minimum ten). A ratio of
two or more is a neutral change clue, with minimum absolute increases of one second
(execution: one minute) or 10,000 tokens. Zero baselines and insufficient samples
are not classified. Cohorts are limited to the selected window. The comparison
is a review clue, can reflect different task complexity and does not assess task
quality. The page never invokes alert delivery, recovery, benchmarks or feedback
collection. Feishu API logs currently lack a reliable Session association; only
instance API totals are shown, never apportioned to people or groups.


### Native Monitor integration (2026-10-12)

Monitor defaults to Overview from the normal homepage (`/?tab=tasks`);
explicit `monitor=automations|usage|feedback` links preserve those destinations.
Clicking Monitor while the homepage is loading keeps that workspace selected
when the initial Session list arrives.
The Overview shows the shared daily/weekly dashboard, followed only by account
balances. The old context guide, named Session
anomalies, owner filters and expandable Session-detail table are no longer rendered.
Their underlying read-only projections and diagnosis policies remain unchanged.
No experiment, disk, API or inspection-scope panel is displayed. Account reset
information and dashboard calculation/source details stay collapsed until opened.

The native view reuses `/api/monitoring/sessions?days=1|7|30&compact=1&dashboard=1`.
Queries coalesce in the browser with a 15-second deadline. A failed refresh retains
the previous data with an error; authentication failure clears it. Refresh preserves
chart phase selections and disclosure states. No new timer, model call or collector
is introduced. Missing observations remain unknown rather than zero.

The former independent monitoring page is now a small entry linking to this native
view, so there is one maintained monitoring interface. Existing saved links remain
usable; the change does not publish instance data to the unauthenticated entry.

The Automations tab also explains system monitoring as a source → processing → write → notification flow. It references the existing background mechanism states and opens this overview for live readings; it does not add a collector or a notification channel. See [Automation flows](task-center-v1.md#compact-flow-explanations). Its delivery disclosures name recipients and explain sending conditions, format and content. The separate [result-relay switch](task-center-v1.md#delivery-details-and-controls) affects newly admitted automation runs; it does not change resource alerts, execution, or independent workflow senders.


## 用量归属与旧账校正

Codex 按 Run 起止时间读取用量时，只使用该时间段内的增量。时间段没有用量记录、边界无效或缺少起点时，返回未知，不使用整个原生会话的累计 token 兜底。没有指定时间段的上下文大小查询保留原行为；这里不改变提示词、消息读取量或 UI。

已确认错误的旧账保留原 JSONL。维护者先用 `node scripts/repair-codex-usage-attribution.mjs --run run_ID` 定向复核，再加 `--apply` 追加校正记录。脚本只处理明确指定、来源为旧 Codex fallback 的已取消 Run，并完整扫描原生日志确认运行时间内没有用量记录。它不按数值大小或取消状态批量删账。校正记录包含原账哈希、原因、日志哈希和时间范围，同一错误 Run 跨日期文件存在多个旧版本时逐个保存哈希并校正，确保历史时间窗口也适用。原始事件不改写；`recordUsageCorrection` 的 restore 动作可以撤回校正。

读取账本时，只有当前记录的 Run、Session 和内容哈希都匹配，校正才生效。未知用量从 token、费用和均值样本中排除，不当作零消耗；有效的取消任务仍保留。之后同一 Run 出现新的有效记录时，旧校正不覆盖新证据。API 的 `quality.excludedRuns` 与紧凑 Monitor API 的 `usageQuality` 提供缺口和原因。现有界面沿用同一个统计源，60 秒缓存到期或服务重启后刷新；本次不调整页面布局。

## Action risk and account continuity (2026-10-12)

Classify business risk separately from the risk of the proposed action. Normal
subscription consumption and an exhausted individual account remain visible in
the account table but do not create an incident or ask a person to replenish it.
The local runtime pool is the authority for usable backups: fleet observations
must never authorize using another instance's credentials. Overview exposes
`accountContinuity`, including the automatic-switch policy, fresh local backups
above 10%, the current balance and the last background switch receipt.
At 20% without a qualified local backup, request a concrete choice (wait for the
reset or authorize/login another account). At 10% with a backup, background
selection changes subsequent requests; a persistent failure to do so is an
incident. Unknown current quota is an observation problem, never exhaustion.
Three observations confirm a continuity notification. Running requests retain
their authorization and are never automatically replayed by rotation.
If the current account is confirmed exhausted and no backup exceeds 10%, the
selector uses the highest fresh positive local balance. The reserve requirement
must not strand subsequent requests on an exhausted account. Low positive
accounts do not bounce between one another.

Disk warnings now enter the existing recovery broker at the warning threshold,
before a critical outage. A repair Harness first investigates the actual source
and existing work, executes authorized low-risk, recoverable steps and verifies
the result. Medium/high-risk operations wait for human confirmation in the
original handling Session. The durable receipt uses `awaiting_confirmation`
and a `plan` with `risk`, `summary`, `target`, `impact`, `rollback` and
`verification`, plus actual evidence. The observer never treats that state as
permission to execute. Human-authorized execution updates the same receipt;
independent recovery verification still applies.

A blocked disk investigation can reopen within the existing attempt limit when
risk materially worsens or the explicitly configured `recovery.policyVersion`
changes. The previous block and every attempt remain recorded. Warning,
critical, below 20 GiB/97%, and below 5 GiB/99.5% (inodes 97%/99%) are distinct
escalation stages. A worsening stage or a new concrete confirmation plan sends
one new notification. Repeated identical observations stay silent; uncertain
sends still require readback. A waiting confirmation never auto-reopens as a
repair. `workflowPaths` must cover each managed filesystem, including data disks;
root-to-data migration is not a remedy when the data disk is itself full.

Alert messages include the business risk, existing low-risk handling or the
specific plan requiring confirmation. They do not equate urgency with permission
to delete unique data, interrupt work, buy capacity or use another account.
Known-unsent batches whose incidents retired or were subsequently delivered are
marked superseded, preserving history without keeping them as current failures.

Feishu quota rejection remains latched across restarts and log retention. A
later real successful call of the same app, HTTP method and sanitized affected
business endpoint (observed within 15 minutes) is now sufficient evidence that
that interface works again. It clears the operational latch and records the
restoration evidence; auth/token success, another app/endpoint and an estimated
monthly balance cannot do so. A new rejection relatches it. Explicit operator
restoration remains supported. Incomplete logging stays visible even with this
positive recovery evidence; it no longer prevents the proven transport from
resuming known-unsent current notifications. This does not infer the tenant's
remaining billing quota or automatically replay uncertain deliveries.

A restriction on another API (for example calendar) must not disable an
independently proven message transport. A successful message send/reply of the
same app, newer than its rejection and within 15 minutes, permits the observer
to deliver current alerts. The affected API's rejection and the unknown tenant
balance remain recorded; its warning is not described as a proven total
messaging outage. No extra probe or test group message is sent. The verified receipt survives quiet periods and log rotation. A newer quota
rejection invalidates it and requires fresh positive sending evidence before
the dependency block can be lifted again.
The dispatch gate uses that same durable evidence and does not impose an
independent expiry that could resurrect the old restriction.

Opted-in automation tasks now link to a [stable home Session](task-center-v1.md#stable-automation-home-explicit-opt-in). The primary link opens the dedicated task-context Session; the original discussion is a secondary reference. Its header reads native execution state directly and distinguishes future-trigger cancellation from active runs. Monitoring and evaluation configuration remain separate; a home is not a new supervisor.


### 群提醒的正文长度

群里的同一事件卡片只保留当前风险、简短处理结果和下一步三行，关键风险和待确认状态标红。处理回执只摘取首句并限制长度；完整方案、对象、影响、恢复办法和验收证据保留在原补救会话及监管详情中，通过卡片链接查看，确认前不执行。低于预警线的 inode 读数不占用卡片正文。更新仍沿用原消息，不因版式变化另发提醒。


### 谁处理、如何介入

卡片下一步区分“我在处理／无需操作”“需要你批准”和“需要你补充信息”。补救回执可用 `humanAction: {type: "approval" | "input", summary: "具体最小动作"}` 标明人的动作；该字段只说明需求，不构成批准。资料、登录或外部操作未齐备时应为 input，不能把仍缺前提的方案显示成只待批准。新一轮执行清除旧的人的动作，执行中不展示上一轮待答事项。

卡片提供对应按钮：查看处理进展、进入会话补充信息、查看方案并回复批准。按钮打开原处理会话，由人看完完整方案后发文字确认或补充资料；点击跳转本身不批准、不启动执行。现有告警卡没有接入一键批准的回调，不能将导航按钮标为“批准并执行”。

首次预警就一次性发送包含风险、处理结果、人的具体动作及按钮的完整卡片，不先发预警文本再补发交互卡。后续沿同一 messageId 更新。用户要求只改代码、暂不改卡或发新消息时，将 `alertDelivery.enabled` 关闭；已有观察与补救继续运行，但新消息与原消息更新都保持关闭，不能因发布完成自动恢复。


## 各指标的处置与固定脚本

对常见报警，可要求维护 Agent：“先运行固定只读检查，说明实际故障和已做的动作；能安全补救的自行完成，需要我介入时明确是批准方案还是提供资料。保持现有消息暂停设置。”

规则由 `lib/monitoring-policy.mjs` 提供给原监管总览和补救提示，卡片根据真实执行回执显示处理状态。规则说明不代表已经执行；只有补救确已准入才显示正在处理。确认方案和资料请求仍在同一张预警卡中，点击查看不是批准。暂无执行回执时不声称正在修复。

| 指标 | 预警与自动处理 | 需要人介入的边界 |
| --- | --- | --- |
| 服务 | 只处理配置范围内真实失败，按配置连续观测确认；计划停用、启动中和成功结束的 oneshot 不报警。原固定会话查服务、退出结果及依赖 | 可能打断业务的重启先给出对象、影响及恢复办法；不能用旧维护记录覆盖新决定 |
| API | 高调用量或重复读取只作本地优化线索。5分钟至少5次失败／慢请求且占比至少20%，连续观测后预警；读取已有日志，不为检查额度额外调用供应商 | 实际受限时请管理员核实受影响接口、真实额度和重置时间；购买、改业务频率、停用或换应用先给方案 |
| 月额度 | 仅接受24小时内管理员实测；80%预警、90%严重，连续观测确认。正常消耗本身不要求人修复 | 先分析调用来源；未形成具体方案前不放“批准”入口 |
| 自动化 | 启用任务失败沿原会话检查产物及回执，只补失败步骤，遵守次数上限；已停用或条件未命中不重启 | 缺资料、登录或外部操作时说明具体帮助；未知发送结果先核实，不直接重发 |
| 账号 | 复用现有账号观察器，提前准备备用；自动切换开启时按10%预留线切换后续请求 | 无可用备用或需要开启切换时由人选择；不自动购买、借用账号 |
| 采集与送达 | 缺失、过期、冲突保留为未知；不以另一轮告警修复告警，不自动重发不确定消息 | 查明确需重新登录、授权或恢复入口后再请人介入 |
| 用量与活跃度 | 消耗多、运行长是分析线索，结合产物、进度及真实错误判断 | 不据此自动终止任务、换模型或改预算 |

固定入口：

- `node scripts/monitoring-diagnose.mjs`：复用本实例有界采集器，输出磁盘、服务、任务、API来源、采集缺口和补救回执。可用 `--kind service --id example.service` 等筛选。只读，不启动补救、不切号、不发送、不重启、不删除；无需新会话或定时器。先用此结果定位，再决定具体动作。
- `scripts/codex-account-observe.mjs`：已有后台账号观察及预留切换执行器，沿现有实例启动参数运行；不新建第二个切换器。
- `scripts/monitoring-alerts.mjs`：已有分钟观察器，复用有界补救与独立验收。`--dry-run` 用于验证而不写入或准入。通知暂停不影响已启用的补救，但同时禁止发送和修改卡片。

这些固定入口不提供通用的“清理全部缓存”或“重启全部失败服务”。具体磁盘清理仍沿对象的已授权工作流，重启与业务重放须核对实际影响。API检查目前是固定诊断，不是自动停流或购买额度的执行器。


### 验证阶段的通知门槛（实例按需启用）

`alertDelivery.noisePolicy: {"mode":"risk_only"}` 提高首次通知门槛，但保留触发后的补救动作、过程和成功／失败结果，均更新同一张卡；不用静默补救隐藏链路。尚未启用此选项的实例沿用原通知规则。采集、较低门槛的风险标记和补救照常运行。

| 指标 | 验证阶段首次通知门槛 |
| --- | --- |
| 磁盘 | 一般预警只留监管页；严重状态连续2个样本才通知。可用不足20 GiB、容量或inode达到97%时立即保留安全提醒 |
| 服务 | 连续5个独立样本确认真实失败；启动中、计划停用仍排除 |
| 重要自动化 | 连续3个独立样本确认失败，不因已启动补救而隐藏通知 |
| 账号 | 无备用、切换未开启或切换持续未完成，且剩余不高于10%，连续3个样本才通知；20%只准备备用；未知额度不报耗尽 |
| API | 5分钟至少10次失败且失败比例至少50%，连续3个样本才通知；只有慢请求、高流量或月额度比例不推送 |
| 额度拒绝 | 15分钟内有新拒绝、尚无随后消息成功证据；历史拒绝保留待核验，不反复推送 |
| 人工介入 | 有证据的具体确认方案或资料请求可以立即提示；点击查看不是批准 |

重复读取同一快照不累计确认次数，较低风险样本不能提前凑齐较高门槛的次数；未知样本打断连续确认，但不算恢复、不重开事件。补救成功仍更新原卡，便于验证触发与处置是否准确。

`alertDelivery.enabled:false` 仍同时禁止发送和修改卡片。配置风险门槛并不授权恢复推送。


各项监管数据旁的“何时提醒、怎么处理”可展开查看统一告警接收群、磁盘／服务固定会话、各自动化实际执行会话及结果出口。账号切换显示后台执行器，API诊断显示固定脚本，不虚构独立群或会话。自动化回报按照实际任务发送配置及执行会话绑定展示；仅有飞书会话绑定、但任务配置为仅RemoteLab时，不声称会发送到群。群名只读取已保存的来源记录；缺名称或未取得会话时明确显示未核实，不为页面刷新额外调用飞书，也不改变任何路由。


公共运行问题的执行会话不需要绑定群：磁盘、服务、账号和API的补救摘要沿 `alertDelivery.chatId` 更新原预警卡。页面分别展示执行入口、补救摘要位置及业务任务结果位置；缺少 Session 绑定不等于缺少回报。业务自动化的原群／话题不变，也不因此额外发第二条消息。

任务没有外部 `resultDelivery` 只说明平台不自动转发其 final，不能断言其固定脚本不投递。核对原任务和脚本配置后，可在实例 `automationReportLocations[taskId]` 保存 `label`、`evidence`、`verifiedAt`，用于展示流程内投递位置；这不是新路由，不替代脚本配置。未核验则明确显示“流程内投递待核实”。明确禁止公共群转发的个人或静默任务列入 `alertDelivery.ignoreAutomationIds`，即使失败或需要人工帮助，也不由统一告警出口外发；原补救及原流程的回报不受影响。不得仅凭缺少绑定就覆盖私聊、禁发或仅本地的决定。

累计 Session token 总数由 chat/session-token-totals.mjs 共享 60 秒缓存；监控 HTTP 入口和飞书已关联话题读取同一账本结果，累计用量与当前上下文占用仍分别显示。

Session 的按需查询详情同时提供[规则与压缩记录](connector-turn-context.md#规则与压缩记录)，区分原生接收、压缩完成和恢复内容生成／失败。该记录不能证明模型理解或遵守规则，也不覆盖原生系统指令、AGENTS.md 和 Skill。

历史 Session 详情曾显示[上下文注入对照实验](feature-experiments.md)的动态标记；现行总览不再渲染该区块，底层投影仍保留：自动注入背景与按需读取两组、限定参与者的新会话范围、50/50 固定分组、独立留样比例、观察窗及夜间评阅开关。暂停新入组、停止实验注入、配置读取失败分别显示；无实验配置不显示。状态沿用 Session 统计最多 60 秒缓存，刷新后以采样时间为准。这是配置状态，不证明实际入组、模型采纳或效果优劣；A/A 模式明确显示两组均按需读取。

## 响应速度（2026-10-13）

历史 Session 详情的“飞书响应速度”（现行页面由下述首次回复指标替代），从 RemoteLab 接受请求计时，到飞书正文投递成功的回执为止。首次正文包含模型开场和进展；首次答复／提问只计 reply、question、final，不把开场、进展和自动受理通知作为答复。两项分别展示中位数、P95、已取得回执／可统计样本数和逐日表；单个 Session 的阶段明细也显示均值、中位数、P95。原有执行耗时仍单独展示，不能当作首回复速度。

复用现有 Request 投递回执，不增加模型调用或扫描聊天正文。只保留时间和统计数，排除附件、表情、Session 入口、受理通知及其他请求的投递。未知、失败、待投递和时间倒置不算成功样本；零毫秒的有效回执仍有效。旧回执没有 surfaceKind 时，仅把请求结算后创建的正文作为旧版最终回复。没有可归属回执的历史保持未知，不补造首回复时间。

当前覆盖已落账前台运行的首条人工飞书请求，受原用量窗口、最近 1,000 个 Run 及读取预算限制；运行中追加输入、未落账的慢任务、Web、其他渠道、自动化和内部任务未纳入。逐日数据按受理日归集为 UTC 自然日，选一天时是今天；整体汇总不受下方归属筛选影响。缺失样本不算零，所有未结束任务的真实等待也未包含在这个分布中。该时间不含消息进入 RemoteLab 前的连接器等待，不证明用户已读或语义上获得了有效答案。日期、模型、任务难度和回复显示偏好都会影响分布，不能单凭下降认定上下文优化有效。


## Agent 今日与七日概览（2026-10-14）

入口为「监控器 → 总览 → 会话概览」。概览沿用监控器的字体、主题色、10px 内层圆角与12px卡片间距，保留单一章节标题；图表、表格和原文链接随现有明暗主题切换，不另外混入参考网站的彩色顶边、直角面板或英文装饰标题。

原地替换 Session 总览的旧汇总卡与 UTC 七日上下文图。今日和七个趋势指标统一以北京时间 05:00 至次日 05:00 分日，今日未结束；下方保留账号额度窗口，旧按群／发起人明细已移除。用量、注入、交付各两张卡展示今日值和七日折线，展开可查精确值与样本数；空缺不连线、不补零。运行数来自当前状态，今日累计数为当日落账 Session 与当前运行 Session 的去重并集；有状态读取失败时显示未知数量。

用量均值是含前后台的已记录 Token 总数除以执行次数，按运行结束／落账日归集，跨日运行不拆分。注入与交付按人工请求受理日归集，统计各自有效的前台执行样本。注入使用 Unicode 字符数，含保存的 modelContext 标题和分隔符，不把 UTF-8 字节、Token、工具输出、Harness 原生历史混算。首轮严格取历史首条用户消息对应的 Run；最多读取开头 32 个事件的窄投影，不能证实时记为未知，不以统计窗口最早记录代替。

普通会话交付指从受理到最终正文所有部分成功送达，按原始入站来源剔除群主线和来源未知，排除开场、进展、其它请求回执、失败和未完成运行。当前飞书最终回执有可验证来源；Web、运行中追加输入和缺少最终回执者不混入交付均值。该值衡量最终答复送达，不宣称业务任务通过验收。旧首次正文／首次答复面板已移除，现行首次回复指标见下文。

“上下文注入来源”默认折叠，先列工作区 AGENTS.md、bootstrap.md、projects.md、skills.md、启动和条件规则的当前原文字数、加载方式与原文链接。明确区分 Harness 加载、启动投射和按需读取，不把原文字数当作实际注入量。随后取最近一个可证实首轮的实际内容块，列名称、实际注入字符数、当前规则文档／组装源码入口和原 Session。来源条目之和等于保存的完整注入字符数。动态人员和群背景并非固定文档；链接是当前规则，历史内容沿原 Session 保存。原生 AGENTS.md、Skill 与工具读取尚不在计量范围，不能推断未读取。固定来源接口 `GET /api/monitoring/context-source?id=...` 沿用实例认证，只接受源码中的白名单，不接受任意文件路径。

页面仍复用 `/api/monitoring/sessions?days=1|7|30&compact=1&dashboard=1`。账本一次扫描同时生成所选窗口和七日数据；七日投影独立缓存 60 秒，最多 5,000 个 Run、256 MiB 冷读、单文件 2 MiB，保留最多 20,000 个文件版本的纯统计投影。群参与读取使用独立的同额冷读预算和 50,000 个文件版本缓存，避免挤占普通首响覆盖；上限可由 createSessionMonitoringReader 的 maxReadBytes、maxGroupProjectionFiles 调整。持久投影版本为 4，旧版由原件重建；缓存不保存消息正文、提示或凭据。接口 agentDashboard 为 schema 2、responseScope 为 ordinary-input，旧消费者须同步来源口径与文案。原诊断读取器的 1,000 Run／64 MiB 限制不变。统计中显示截断、缺失与实际覆盖。读取既有 JSON 后仅保留统计字段，不另读聊天事件正文或启动模型。查看原文只在点击时进行。Hub 接入应复用相同 schema 和渲染资产，仅向已认证用户提供必要的汇总与账号窗口，不复制对话正文或实例凭据。

### 已撤下的 Test 同步预览

Test 曾作为 MukaHub 移植预览，与正式总览使用相同的数据和组件。迁移完成后，2026-10-16 撤下重复标签、面板和独立刷新路径；旧链接回到正式总览。总览保留七项指标、来源说明和账户详情；MukaHub 同步沿原快照通路运行。

平均值标题注明“每次执行”或“新 Session 首次执行”，每张卡解释分母。用量含前后台，注入只统计前台，交付耗时只统计有最终正文回执、来源可判定为普通会话的飞书前台执行。指标与账户独立读取，单项失败不影响另一项；刷新保留展开选择。

### 时长阶段切换与展示范围（2026-10-14）

保留现有布局和原六张指标卡，两张交付耗时卡各自增加阶段选择：收到→最终送达（默认）、收到→开始运行、运行阶段、运行结束→最终送达。选择只更新本卡的今日均值、七日趋势和逐日表；刷新保留阶段与展开状态，不新增图表或请求。

总耗时沿原最终正文回执口径。阶段使用同一条已完成飞书执行的 acceptedAt、startedAt、completedAt、最终正文全部 deliveredAt；四个时间齐全且有序才纳入阶段统计。阶段样本的三段相加等于其总耗时，阶段样本数可能小于原总耗时样本数。没有时间记录保留空缺，运行结束不表示工作验收完成。所有阶段按请求受理所在的北京时间 05:00 统计日归集，首次执行继续严格限定 Session 历史首次执行。

总览在会话概览下方保留群主线参与区与账户余额，移除单独的 token 总数板块；实验状态、API、磁盘和检查范围板块不展示。旧具体会话卡片、异常统计和会话列表不再渲染。当时 Test 复用同一展示，现已撤下。

### 首次回复与各环节用时（2026-10-14）

总览提供第七张“普通会话首次响应时间”卡，从原始飞书消息的
`sourceContext.createTime`（毫秒）到第一条成功送达的文字回复计时，包含开场、进展、
答复、提问和最终结果；排除表情、自动受理通知、附件及其他请求的回执。
不限定新会话，按消息发送所在的北京时间 05:00 统计日归集。缺少发送时间、
发送时间晚于受理或缺少送达回执时不计入，不能用受理时间冒充发送时间。
覆盖仍限于现有账本关联的可归属执行；执行中的追加输入不制造独立样本。
来源优先读取原始 inbox，普通群主线剔除；私聊、原生话题群及话题续聊保留。群内引用或回复可只有 rootId，不能据此当成话题续聊。inbox 缺失时只采用可判定的 Request 来源，改写后的开话题目标不足以反推原输入；来源未知剔除并展示缺口。
归属按 publicationRequestId 保持逐输入一致。同次执行里追加输入产生的较早回复不提前根输入首响；执行级首次可见输出是另一口径，本面板不把它当作输入完成证据。
送达回执表示平台接受投递，不代表人的客户端已显示或人已阅读。

图表下方直接显示“今日各环节用时”，列出消息接收、排队与准备、启动执行、
执行过程、结果发送以及合计，分别给出计时范围、平均用时和统计次数。
只使用 sentAt、acceptedAt、preparedAt、startedAt、completedAt 和最终送达时间
全部齐全且有序的同一批记录，按发送日归集，五段均值之和等于合计。
缺少准备时间只排除该表样本，不影响独立有效的首回复或最终交付指标。
首回复可能发生在执行过程中，是独立指标，不作为第六个环节重复加总。
页面用“会话”“执行记录”等中文称呼，移除旧会话明细；账户展示保留；底部单独的 token 总数板块已移除。

### 群主线参与（2026-10-23）

普通会话响应与群主线参与分区。`agentDashboard.groupParticipation` 复用既有 connector inbox、participation-state、conversation-settings、Request、投递回执、Session 路由及纠错用量账本，不写新的消息或消耗账。输入限原始普通群主线的人工发言；七日窗口与普通会话一致，均在北京时间 05:00 分日。群与消息按 connector route 隔离。

| 展示项 | 统计依据与缺口 |
| --- | --- |
| 当前参与群 | 已配置或有主线参与状态的群，应用现行有效设置、模式覆盖及静音；区分主动、旁听、暂停、未知。当前快照不冒充历史状态或平台成员资格 |
| 输入处理 | 原消息 ID 去重；处理、不回复、失败／取消、处理中、待确认互斥。处理含文字覆盖、参与控制和已接纳转交；失败包括文字投递失败；没有回执不推断为不回复 |
| 文字投递 | 外部消息 ID 去重；依据实际目标与 thread ID 分群内、新话题、已有话题、未知。合并回复仅用明确 contract 关联覆盖输入，回执和文字首响只归所属输入一次 |
| 新工作话题 | 既有 routing／work-plan 关系与原消息锚点关联实际开话题回执；数量和建立时延单列，缺回执不能算已建立。子话题后续回复不转计原输入完成 |
| 社交表情／处理提示 | 实际 reaction ID 去重，自动处理提示单列；删除不计新增。旧表情替换缺可靠创建时间则保留数量、时延为空 |
| 群主线 Token | 原纠错账本按 Run 去重，仅群主线运行；关联工作 Session 排除。属于全实例总量子集，不重复相加。按落账日归集，与消息发送日不同；缺输入计量、缺来源 Run、账本截断单列，无法关联的后台调用不分摊 |

表格及口径说明显示数据覆盖；原始来源、消息时间、请求、外部 ID、开话题回执或归属缺失不补零。相同运行的其他输入拥有文字回执时，只记录归属缺口。当前版本不回写历史归属，不改变参与决策、回复显示、模型、提示及执行／投递策略。

实例独立监管站的接入与隔离预览见 [Agent monitor integration](../integrations/agent-monitor/README.md#instance-owned-supervision-partition)。原成本页的全留存历史与 00:00 分日保留；本区七日 05:00 活动窗口不能替代或叠加旧账。

### 监控文案与底部汇总（2026-10-14）

底部移除重复的 token 总数板块；上方“今日 token 总量”“平均 token 用量”和七日趋势保留。
会话概览使用 token、上下文注入、首次响应、交付用时等术语，明确注入量单位为字符。
概览标记为无需浏览器自动翻译，避免将 token 或执行术语翻译成“代币”“跑步”。
本次仅调整展示与说明，不修改指标计算、账号切换策略或任何实验配置。

### Private metric review and verified action receipts

To activate this extension, ask the instance agent to verify the existing private
recipient and enable `sessionDiagnostics.metricPolicy.enabled` and
`sessionDiagnostics.reportActions` as needed. Both default off; general group delivery and
its risk-only setting remain independent. The existing five-minute diagnosis
cycle performs the analysis and sends or updates private cards. No new schedule
or independent classifier is needed. With private `noisePolicy.mode: "risk_only"`,
metrics are observation-only unless `sessionDiagnostics.metricPolicy.notifyOnRegression: true`
is explicitly enabled. This separate switch restores metric review notifications
without enabling routine account/action reports or changing group delivery. A
qualifying cross-Session metric sample notifies on the next diagnosis cycle;
it does not need three repeated observer scans. A further rise of 30 percentage
points updates the original card after the existing analysis cooldown. Recovery
updates it once; ordinary sample/count fluctuations do not send again. Explicitly
paused delivery still suppresses sends and edits, including replay on resume.

The alert card preserves the trigger, analysis, action actually taken, verification,
and remaining human decision. Successful automatic default-account switches,
per-Session quota migrations and evidenced recovery results remain reportable.
The account check also reads recent Sessions' actual bindings; a healthy default
cannot hide an exhausted old binding. A switch record proves selection, while a
subsequent successful run supplies separate execution evidence. No old task is
replayed merely to verify an alert.

Metric review covers injected context characters, Feishu first delivered response
(from provider message timestamp), and final delivery (from Request acceptance to
all final message receipts). These are completed foreground Requests; missing,
failed, unfinished and native follow-up records are not silently made zero.
Injected characters measure the RemoteLab manifest, not the Harness's full input
or billed tokens. The reader keeps bounded numeric projections, not prompt copies,
and exposes missing/limited/truncated source coverage. Incomplete bounded scans
suppress population alarms until a complete scan is available.

Two comparisons remain distinct:

- Matched model, effort, Harness, surface, first/follow-up and recorded experiment
  cohort: last 24 hours versus up to seven complete populated business dates
  before that window's starting date, looking back at most 14 days. Each reference
  date needs five runs across two Sessions; the combined reference needs at least
  three dates, 20 runs and five Sessions. Partial dates never enter the reference.
  A 30% rise also needs an absolute increase
  (1,000 characters, five seconds first response, or 30 seconds final delivery),
  at least 10 current runs across three Sessions, 20 historical runs across five
  Sessions, and a rise in at least 60% of Session medians. Sessions have equal
  weight. Smaller current samples remain observations, even when apparently much
  better or worse; they cannot establish an improvement or trigger a trend alert.
  High historical variability is labelled.
- A daily population comparison uses today's per-request mean versus the preceding
  up to seven complete populated business dates (05:00 Asia/Shanghai boundary), with at least three historical dates and at least 10
  runs and five Sessions on each date. A rise of 30% and the same absolute floors
  must remain after separately removing the Session with the largest effect on the mean from each window.
  The filtered current and historical means use the same exclusion rule.
  A one-day jump can therefore alert without four consecutive days of growth;
  a lone expensive Session cannot trigger this comparison. First-response dates
  use the provider message timestamp where present, matching the dashboard.
- The overall per-request mean is also reviewed when it rises across at least four
  populated business dates by at least 30%, with at least 10 runs and five
  Sessions on every date and a corroborating rise in Session medians. This
  catches changed experiment/task composition without claiming same-task
  regression. Current-day incompleteness and experimental share are shown.

The existing `sessionDiagnostics.metricPolicy` accepts `referenceDays` (3–10,
default 7) and `excludedDates` (explicit `YYYY-MM-DD` Beijing rest dates). Rest days
are never inferred from weekends. Calendar-date samples are excluded even before
the 05:00 reporting boundary; a reporting date explicitly listed as resting is
also skipped as a historical reference. An idle or insufficiently sampled date
is skipped, not treated as zero. Evidence lists exact reference dates and counts.

A separate same-configuration comparison can flag a return from a recently lower
level even when the long reference is not breached. The latest complete period
with at least 10 runs across three Sessions must have dropped at least 30% (and
the metric's absolute floor) against at least three earlier supported dates with
20 runs and five Sessions. A subsequent rise needs the normal current-sample,
absolute and cross-Session conditions. The lower level remains an unconfirmed
observation; no code/configuration change or optimization benefit is inferred.
Task content, concurrency and effective versions are not fully paired. Evidence
shows common Session coverage, which does not itself establish matching tasks.

An explicitly changed baseline policy rechecks active same-configuration incidents
only with complete collection, a supported historical reference and present current observations. Old small-sample alerts may be withdrawn by the stricter rule without establishing an improvement. The
original private card and pre-correction evidence are retained. A comparison that
no longer qualifies is marked “基准已更正/已复核”, not performance recovery. A lack
of data cannot close it. Existing unresolved incidents keep their original
recovery target while new comparisons report their actual current reference.
Already closed legacy cards retain their delivered notification identity; a
reference-policy upgrade does not announce their old recovery again.

Increased daily request
volume alone cannot trigger these per-request comparisons. Experiment exposure
is read from the original record; unmarked does not mean nonexperimental.
The first analysis compares injection sources or timing phases and reports clues,
not a causal verdict. It does not delete context or repeat business work. Review
cards update in place with a 30-minute analysis cooldown; at most three deliveries
occur per cycle. Recovery requires at least 10 genuinely newer runs across three
Sessions within 15% of the original baseline. Silence is never recovery. Uncertain
message delivery remains pending readback rather than creating duplicate cards.

### Test 紧凑布局演示（2026-10-14）

Test 默认仅展示一张 Agent 监控摘要卡：运行中会话、今日 token 用量、平均首次响应时间及账户额度状态。点击“查看详情”打开侧栏，手机上占满屏幕；关闭或按 Escape 返回摘要卡。详情分为用量、响应与交付、上下文注入、账户四个标签，每个指标标签共用一个可切换的趋势展示位置。各环节用时表在响应标签直接展示，注入来源与统计口径仍可折叠。

刷新保留当前详情标签、趋势指标、耗时阶段及折叠选择；账户与运行数据分别失败时保留另一部分可用数据，未知额度不会显示成正常。本次只在 Test 演示收拢方式，正式总览维持原布局，Muka Hub 未修改或部署；继续复用原有两个数据请求，无新增采集或定时器。

后续按 Hub 参考图调整 Test 的默认占位：左侧 Agent 分类标题，右侧整行运行概览，四项摘要横向排列，“查看详情”放在右侧标题栏。视觉沿 Hub 现有 Operations 配色使用运维橙（#b6542c）、白底（#fff）、灰线（#d9ddd9）和深色文字（#171918），搭配直角与更紧凑的文字；窄屏先将分类标题移到上方，再将指标排成两列。此前四标签侧栏与数据口径不变。本条取代上文“一张独立小卡片”的首页尺寸说明。

组件同步使用这套样式：指标选择的强调线、标签栏、图表、阶段下拉框及账户表采用一致的颜色、边框、字号和数字排版；可用、耗尽与未知仍用独立状态标签区分，避免将主题色当成健康状态。暗色模式另外适配可读对比度，不将 Hub 浅色值直接套进暗底。

手机账户表将最近观测时间放到账户名称下面，在同一屏内保留账户、状态和额度三列；暗色模式对可用与耗尽文字单独提高对比度。

### 正式总览完整展示（2026-10-16）

根据用户反馈，总览直接展示完整指标，不再以四项概览加抽屉收纳详情。运行中与今日活跃会话、七项今日指标和趋势、今日各环节用时、上下文来源、账户额度在同一页面阅读。沿用既有响应式网格，手机单列；时长阶段、每日明细和来源展开状态刷新后保留。

撤下与总览重复的 Test 标签、面板与独立加载路径，旧 Test 链接回到总览。账户重置时间并入额度表，不再另列同一批账户卡片。用量分析仍负责期间和会话筛选，其观察时段与总览的固定统计日不同。继续复用原两个数据源，单项失败不影响另一项；采集、告警、同步和 MukaHub 页面均不因界面调整改变。此条取代2026-10-14的紧凑总览方案。

日报截图工具继续从总览的账户区提取截图，使用本轮冻结的账户数据，不增加上传或消息发送。

### 预警卡片与处理历史（2026-10-15）

资源监管（磁盘、服务、账号连续性、API、自动化）与私信会话诊断采用相同的信息顺序：具体异常标题、触发时间和依据、分析与实际行动、需要人完成的动作。活动预警使用橙色或红色；独立观测确认恢复后更新原卡，保留原始原因并显示恢复时间、复查结果和处理归属。暂停或取消任务只标明停止，不当作故障修复。调查完成、运行退出、请求人工帮助均不证明问题解决。

处理归属读取已验收补救回执中的 `resolution={method,evidence}`。method 为 agent、collaborative 或 spontaneous，分别表示 Agent 自行处理、人机协作处理、指标自行恢复；必须包含对应行动或人工参与的来源。旧记录缺证据时显示归属尚未核实，不推断功劳。正常的独立恢复验证仍按原门槛执行。

卡片提供默认收起的历史执行记录，按有意义的状态、行动和结果追加，普通采样不新增历史；触发记录冻结，恢复不能覆盖。最近20条在卡内展开，其余沿原处理会话及原事件账本查询。已有专属处理会话优先链接；只有单个异常来源会话时明确标为来源；没有处理会话不得把监管首页伪装成原始对话。

配置已有 snapshot 浏览器能力时，发送前将触发时的监测记录节选截图并通过当前告警 Bot 上传，缓存图片回执。截图不重新读取实时界面、不混用其他 Bot 的图片；图片生成失败仍展示文本依据，不阻断真实预警。资源告警的原始依据图片保持原样，解决后不撤回。展示更新不启用已暂停的诊断、不变更收件人或通知门槛；指标私聊现已按收件人启用三小时合并：首轮、后续轮、总体与同类任务仍独立诊断，但三小时内新增异常统一更新同一张卡；已归入卡片的问题即使跨过窗口仍更新原卡，不按时间重复新发。升级时复用最近已有私聊回执，不再额外推一张。夜间免打扰尚未启用。


指标合并卡先展示异常数值、主要增长来源及处理状态，同类任务与总体的重复统计收进默认折叠的依据区，原始证据完整保留。没有修复记录时明确显示尚未修复，不把统计核对写成处置完成。截图复用监管页面折线组件和同一轮采集的数值，固定展示最近五日并标精确末值，完整七日历史沿原页面查看；不重新采样或访问带身份的页面。图中展示全量均值，正文分别注明首轮／后续轮与同类任务口径；实质变化时刷新截图并标数据时间，图片失败保留文字证据。暂停、样本覆盖缺失、不确定投递不补发等约束继续有效。原始诊断与历史回执保留在既有诊断记录中。

## Independent monitoring presentation (optional instance setting)

An operator can ask: “Reuse this instance's existing monitoring collectors and
replace its dashboard entry with our approved independent supervision site.
Preserve authenticated automation management and prompt-review actions.”

For that instance, `CONFIG_DIR/monitoring-portal.json` accepts
`{"enabled":true,"url":"https://approved-monitor.example/"}`. Only HTTPS URLs
without credentials, query or fragment are accepted. Absent/disabled/invalid
configuration preserves the existing interface. For a trial before replacement, use
`{"enabled":false,"preview":true,"url":"https://approved-monitor.example/"}`.
This adds only a Settings link labelled “试用新版监管”; all existing Monitor
views and action controls remain in place, with no automatic redirect. The link
passes only `from=settings` and an optional UI theme. A return to
`?tab=settings&monitorReturn=1` restores the Settings scroll position saved in
that browser tab. The independent page must provide this return link.

The destination receives no
credentials, Session identifiers or private API responses from this redirect.

The Monitor entry and old overview/usage/feedback/security bookmarks open the
configured presentation. Settings also provides a link. Automation management
remains at `?tab=tasks&monitor=automations`; prompt source inspection, filtering
and bounded supplement-review remain at `?tab=tasks&monitor=security&manage=1`.
An explicit `manage=1` also retains original usage filters, formal feedback and
overview incident/delivery evidence. The new presentation should link these
tools wherever its aggregate view does not cover the detailed operation.
These are authenticated action tools, with a return link, not duplicated dashboard
navigation. Collectors, schedules, original ledgers and permissions are unchanged.
A presentation migration must separately verify public-field minimization,
retained-source freshness, cases/reviews, and action-tool accessibility. Existing
usage-analysis aggregates can be reused, but must retain whole-instance vs
project scope, collection gaps and unknown denominators. Rule acceptance is
transport evidence, not task acceptance or benefit attribution.

### Authenticated memory file evidence

An optional `monitoring-evidence.json` in the instance config directory supplies
`registryPath`, `statePath`, `sourceRoot`, `indexDir`, an HTTP(S) `returnUrl`,
and optionally `previewPort` for the independently running local preview service.
The registry and private version state are produced by the existing monitoring
collector. This does not change the Settings entry or enable a monitoring migration.

`GET /api/monitoring-evidence?groups=<registered-group-ids>` lists the observed
files after normal RemoteLab authentication. A `file=<opaque-id>` selects a file;
`read=1` previews its current text, with size/format/path checks and escaped
content. Public dashboards link here without carrying credentials or publishing
file bodies. File lists remain limited to the registered, observed scope.

Completed native `file_change` history events project private pointers into
`indexDir`, only for registered paths and their matching accepted request/session.
Forked or imported history is not treated as a new modification. The page rereads
the canonical event and accepted request before showing the source conversation,
original instruction and a `source=<session-id>:<event-seq>` link to the original
instruction and saved diff. The instruction is evidence for purpose, not an
inferred per-file rationale. The index retains the latest 200 events per file;
historical backfill must state its time coverage.

Version sampling and native file operations are displayed separately. Time
proximity does not prove that a native operation caused a sampled version change.
Shell edits, background writers and missing native events can remain unlinked;
missing provenance never means authorization. Read access is covered by the
instance's existing authenticated-user model, not the public dashboard.


With `previewPort` configured, `/monitoring-preview/` serves the same preview UI
behind existing RemoteLab login, without forwarding cookies or credentials to the
local service. Only fixed dashboard/case-workbench assets and read-only snapshot/review endpoints
are proxied; HTML/JS root-relative dashboard URLs, including the brand's home
link, are scoped to the prefix. Native evidence and issue-action APIs remain
on the authenticated origin. The
preview Settings link may use this URL while `enabled:false` keeps the old primary
monitoring entry intact. The independent public preview remains available.

The fixed asset allowlist includes `feature-trials.js`, imported by the current
dashboard entry. A missing module blocks all browser enhancements even when the
server-rendered snapshot is visible. Validate module loading through the
authenticated preview as well as the independent site; private files remain
outside the proxy allowlist.

Object drawers fetch `fragment=1` from the authenticated evidence endpoint and
show the file list immediately. File bodies, modification records and source
instruction/diffs expand in place. Long metric notes are collapsed. Public-origin
visitors enter the authenticated preview once; no private content is copied into
the public snapshot and no cross-site authentication token is exposed.

### Handle an analysis issue in a new Session

An operator can ask: “Add 去解决 to each analysis finding. Preserve the finding,
its evidence and acceptance criteria in a new web Session, then submit the work.
Keep existing management tools available when switching the Monitor entry.”

The optional instance file `monitoring-resolution.json` supplies an absolute
`analysisRoot`, HTTPS `portalUrl`, HTTPS `publicOrigin`, an optional absolute
`resultWorkflow` Markdown path, and an optional `runtime` profile (`tool`, `model`,
`effort`). The provider defaults apply when the profile
is omitted. This file enables no scheduled analysis and grants no public API
access. `analysisRoot/runs/<timestamp-id>/report.json` and `input.json` must be
immutable saved analysis records; `report.inputHash` is the SHA-256 of
`JSON.stringify(input)`. The report contains `output.items` with stable IDs and
`evidenceRefs` pointing to the input's evidence records.

After normal personal login, `POST /api/monitoring-resolution` takes only
`{report,item}`. It requires a same-origin JSON request, reads the matching saved
report and evidence, and uses native Session creation and idempotent HTTP message
admission. It attributes the work to the clicking Person. A stable Person/report/
item key reuses the same Session across concurrent clicks, refresh and retries;
an archived handling Session is opened without restarting it. A failed submission
can be retried into the already created Session. A GET reports the existing
Session and whether admission was recorded; it never starts work.

The initial message carries only the selected finding, proposed next step,
completion condition, snapshot time and exact saved-file/evidence-ID pointers.
The full analysis prompt, hashes and raw evidence remain in the immutable report
and input files for reading on demand, rather than being pasted into the message.
It directs the Agent to check the current state and existing work before acting.
An already admitted request is reused without resubmitting or rewriting its text,
including requests created before this compact format was introduced.
When `resultWorkflow` is configured, new handling requests include that local
method pointer. The handling Agent records its judgement against the original
completion condition and the actual verification evidence before delivery. This
is an instance-owned result adapter, not a second model reviewer or a new
schedule. A run ending or a Session being archived is not resolution evidence.
The independent display can hide findings with verified resolution receipts,
omit the whole attention block when none remain, and retain immutable reports
and receipts outside the homepage. An unfinished result remains visible.
The source report is dated evidence, not expanded authority: consequential business
stops, permission changes and external messages still require their applicable
authorization. No group delivery is inherited from another Session.

The independent public site opens `/monitoring-resolve?report=...&item=...` in a
login-protected window. That window accepts an explicit click relay only from
its opener on the configured public origin, for the exact selected report/item,
then makes the same authenticated POST. A copied link or link preview only shows
the issue and a launch button. Login preserves the destination; if the opener
is unavailable the user can launch from that authenticated page. Credentials
never enter the public site. Case-review links inside the authenticated dashboard
stay on that origin for named shared reviews; the public URL and its historical
browser storage remain available independently.

#### Employee SSH Codex memory evidence

An explicitly enabled `employeeHelper` in `monitoring-evidence.json` points to a
root-owned installation of `scripts/employee-memory-evidence.py`. The existing
authenticated evidence endpoint accepts `employee=<local-account>` and an optional
16-character file ID. The helper resolves the account from passwd, accepts only
current `/data/home/<account>/.codex-sg/memories` Markdown files when that
installation exists, otherwise `.codex/memories`, and never accepts a
request-supplied filesystem path. Directory traversal uses no-follow file
descriptors; previews are read-only, escaped, no-store and limited to 2 MiB.
Deployments must explicitly authorize this employee-memory scope and supply an
existing service-account sudo route; this option does not create sudo permissions.

Public monitoring exports may contain per-account counts, Unix mode bits and
redacted file identifiers, but never employee memory bodies or detailed filenames.
The employee list is distinct from the agent instance's own memory. Native memory
database counts and `usage_count` are metadata, not file-read counts or proof of
injection. SSH-native conversation attribution remains unknown unless backed by
an explicit source record; do not derive it from timing or a matching name.

The preview keeps employees in a compact directory and distinguishes absent memory
databases from zero recorded usage. Read/write counts cover only the observer
window; they are not historical totals. Its shared Skill catalog reuses reviewed
entries, labels team-shared versus instance-only methods, links authenticated
original files, and separately counts recent successful document-load tool calls.
These counts do not establish completed Skill execution or cover SSH-native calls.

The authenticated proxy keeps case navigation under `/monitoring-preview/case-review/`
so the existing personal login and shared project-feedback API are available.
The public case URL and its old browser storage remain available; public readers
follow the explicit login link to submit named reviews.
The proxy rewrites known presentation URLs and the HTML home link only. Plain
JavaScript separators such as `'/'` in chart date labels are preserved.

Case lists and their review drawers show initiator, initiation time and latest
message time. The preview's `case-metadata.mjs` refreshes these fields in the
existing collector from exact registered case/session associations and cited
message sequence numbers. Identity comes from the original message's confirmed
sender; delegated work may use its recorded initiating identity. Collection dates,
Session settings timestamps and tool/status events are not message times.

For shared or long-lived conversations, only the cited case message window is
used and labeled “案例记录”; a dedicated topic may report its latest human/assistant
message, labeled “关联话题”. Cases lacking an original assignment or exact source
association display a missing value. These metadata projections do not change
source evidence, existing case IDs, comments or reviews. The renderer is shared
through `case-review/overview-model.js`; both the public site and authenticated
Monitor proxy retain the same fields.
