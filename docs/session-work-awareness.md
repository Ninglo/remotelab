# Session 开工、相关工作与参考建议

收到新需求时，RemoteLab 记录这条输入的已核作者和项目关联，默认只提供来源与少量人员／项目指针。相关工作、必要背景和资料读取状态由 Harness 按需查询，不再每轮自动检索和注入正文。平台不另调用一个模型判断谁应该做什么，也不把相关 Session 的建议当成用户授权。

## 默认指针与按需读取

项目关联来自 `project-runtime.json` 中已经配置的来源群或明确 Session 绑定。Agent 声明的新项目标签保留为候选；标题、侧栏分组和项目负责人不能代替关联依据。项目主账、公司资料、人员档案、方法正文继续在原维护位置保存。

每条已接受的普通人类输入在所属 Session 中留下有限的需求记录。它是检索线索，尚不表示已经归类成一项任务。Agent 可以用 `remotelab work start` 登记具体目标、操作对象及候选项目，用 `work update` 登记状态、结果、成果和方法的来源。开工登记不排他，不存在先开始者占有工作、自动停工或自动分配责任。

相关检索只检查已登记的任务目标、操作对象、成果引用及已有的会话工作摘要，不扫描对话全文，也不把最后一句原始聊天当成任务。显式检索使用 Agent 给出的具体任务查询；短句“继续吧”等没有有效主题时才沿已登记的当前工作读取。明确提到一个现有会话名称中的主题也可产生候选；Agent 理解本轮目标后可用 `work context --query` 显式检索。常见语气词和跨任务高频字词不作主要线索，词语检索只产生 `candidates`，不直接出现在相关工作面板。已有摘要只证明可查工作记录，不证明成果已经验收。

面板的 `related` 最多三项，可为空：声明操作对象完全相同的工作，或当前 Harness 已核对具体重复、依赖、复用关系的来源。Harness 复用本轮理解，不新增前台模型调用；用 `work review --file` 保存关联理由和本轮读取证据，只改变本会话的参考列表，不发消息、不改变其他任务，也不批准跨 Session 建议。关联可以来自词语候选或另行查到的确切来源，不要求两边措辞相同。每项携带来源记录指纹，来源改变或本会话接受新输入后旧核对失效。推荐尚未核对时不以候选填充空位。

相关资料先说明“为什么出现”和“现在可做什么”：用一句话写出来源里的具体资料或结果，以及它能帮助当前任务的哪一步；读者可直接查看资料，无需作同步或采用确认。工作目标、结果和登记时的消息放在展开区。已登记工作从对应接受记录核对入口、作者和消息时间；旧摘要没有原始消息记录时明确标注未知，只显示当前对话入口，不把现有群绑定说成原消息来源。摘要旁的时间表示对话记录更新，不能用已读时间冒充信息更新时间。

词语候选仍可能漏掉同义表述、遗漏登记或含糊目标；当前 Harness 的核对也可能判断失误，不能声称系统能保证没有重复工作。旧对话不自动回填任务或重新调用模型；已有摘要可作检索线索，必要时沿原来源继续核对。

人员身份与项目关联分别处理。当前请求者按已核 Person／Identity 读取；引用、提及、收件涉及的其他人员也读取适用的称呼规则。来源消息保留原始身份 ID、消息 ID 及来源域；同名、昵称、参与者哈希、机器账户和 Session 创建者都不能证明作者。唯一登记的完整姓名可以识别被提及的对象，不能认证引文作者。未知身份保持未知。

默认上下文不读取他人的档案，也不投影称呼规则；引用他人时按需读取其已核档案或使用下方人员查询，个人偏好按适用对象和任务判断。确认过的规则直接遵守；它与跨 Session 未批准的业务建议不同。原文引句保留原作者和内容，Agent 自己新增的称呼使用现行登记名称。工作中引入新人物，可执行 `remotelab work people --query <涉及人物的文字> --json` 回读。

公司资料仍在 `reference/company.md`。Agent 判断任务需要时读取原文，或使用显式查询；就餐、地点等字样不会再触发默认上下文读取。当次明确地点、范围和约束优先；旧网页餐饮线索仍需当次核验。`memory context`、`work context` 共用按需读取模块，不另建资料主账。

显式 `memory context --query` 或 `work context --query` 可以从已登记导航和启用的项目主账中检索原文，即使新 Session 尚未绑定项目。例如“副屏”可以命中已有说明，不要求再提供一个关键词。匹配已有标题或正文起首的主题优先于同台电脑等偶然重叠；正文最多返回四段、3600字符，附原路径、章节、行号和版本。导航中的匹配 Markdown 链接最多读取六份、每份64KiB，只沿实例任务、领域和现行操作入口；不遍历人员档案、候选箱、归档或 Harness 私有记忆。启用的项目主账最多1MiB；关闭项目开工增强后不读主账。命中只是参考，不推断项目绑定、不恢复暂停事项，也不把历史配置当作实时状态。这条读取路径只用于显式查询，普通开工和续接不调用它。

读取结果区分找到、登记来源未找到、来源不可用、部分读取／预算跳过及不适用，附路径、读取范围与版本 hash。无匹配只代表已查范围无匹配。配置或档案损坏不能静默解释成没有记录；超预算的必要规则留下原位置，使用前继续读取。文件更正、撤销后，下次显式查询重新计算 hash；已进入原生线程的旧上下文仍须由 Harness 按当前版本纠正，磁盘更新本身不会擦除旧记忆。

## 网页独立新话题的背景续接

可以直接在网页新开话题，说明要讨论的目标，例如：“想讨论仿真评测的可比性，请先找已有背景和明确决定，说明这次适用的要求；先不启动评测。”不用先知道项目 ID 或手动关联群。开启项目上下文的实例会为普通网页输入提供简短的查找指引；具体是否检索、查什么、采用哪些要求，仍由当前 Harness 根据任务判断。简单、自足的问答不需要检索。没有新增分类模型，也不自动把所有简报灌入新话题。

已有明确 Session 登记、来源群和真实父链是优先的归属证据。独立网页 Session 的标题和侧栏分组不证明项目归属。Harness 用现有 `work context --query` 查询工作与原文，同时在 `projectBackground` 读取登记归属、项目名称候选和来源指针；项目名称匹配只产生候选，可能漏掉别名，也可能同时命中具身评测和真机评测。对应关系不清时保留候选，具体询问要讨论的范围，并继续不受影响的工作。

核对候选时，`remotelab work context --query '当前目标' --project <登记ID> --json` 按需读取该项目的当前简报、配置中的方法入口和适用范围内的现有方法记忆；`remotelab work directory --project <登记ID> --json` 查看该项目已接入的话题、时间和状态。这两个读取都标为 `explicit-reference-selection`，保留原来的 `confirmedProjectIds`，不修改 Session 绑定或项目配置，也不代表已经采用规则。未指定项目时，读取已有登记范围；没有登记则只提供候选。关闭项目上下文后不读简报，关闭目录后不提供目录。

简报附原路径、公开资料链接（若已登记）、版本 hash、修改时间和正文行号；最多读取48KiB的单份简报，返回正文总预算6000字符，放不下的整份保留原位置和缺口。目录沿既有 Session/work 原件生成，不扫描聊天全文。Harness 再按需要读取相关原话题、项目主账与现行规则，核对人的明确决定、更正、适用条件和冲突，说明实际采用的背景及可追溯来源。检索结果和认知中的旧状态不证明此刻正在执行。

切换项目时重新核对本轮范围，不沿用上一项目的限制；参考读取不能抹掉原登记，也不会自动把新话题绑定到候选。新内容与更正随下次读取重新取原件和版本；材料缺失、损坏、预算跳过和没有名称匹配分别说明，不能宣称已查尽。暂停、取消和历史项继续作参考，检索命中不增加权限、不恢复工作。隔离测试覆盖候选、父链、独立绑定、切换、更正及失败边界；真实网页新建输入与 Harness 的实际读取、采用行为仍须单独验证。

## 隐藏的项目工作目录

项目归属尚未登记、但已明确要共用话题目录的群，可在实例配置添加 `directoryGroups: [{id, name, sourceRouteId, chatIds}]`。成员必须是当前配置中已有且非 excluded 的群，每个群只能出现在一个目录分组中。它只为没有项目绑定的输入补充目录，不建立项目归属、不继承认知正文、不改变阅读层级、群响应或暂停状态。原有项目目录优先；网页子会话沿真实父链继承，其他群输入和显式 Session 绑定不能借父链跨入。目录直接读取服务端 Session/work 记录，每次准备输入重新生成；不依赖 Mac、增强客户端、原生群编号关联或可见看板。不包含尚未进入本实例的纯人类讨论。空目录表示当前无已接入记录，不等于群里没有话题。

可向 Agent 交办：“按已有项目登记，让同一项目的讨论群、干活群和网页子会话共用隐藏工作目录；随认知文档提供给模型，核对时间和状态，保持现有转交授权。”Agent 先核实实例 `project-runtime.json` 的 `projects`、`groups` 和 `sessionBindings`，再启用 `directoryEnabled: true`；同时需要 `enabled`、`contextEnabled`。未配置时关闭。不要根据群名补造归属，也不要求每个项目恰好有两个群。

目录读取现有 Session、工作记录和运行状态，不另建业务主账，不向群里发卡片。明确登记的群共用项目目录；网页子会话沿 `delegatedFromSessionId` 的真实父子关系取得目录和认知文档。子会话有独立项目登记时使用自己的登记，不继承另一项目。没有确认归属的会话不按标题、人物或相似内容自动绑定。目录提供检索候选，Harness 读取原件后判断归属与接续；它不启用个人分流试验、不扩大跨群权限，也不自动恢复旧工作。

条目包含工作目标、来源会话与父子关系、可打开的入口、创建时间、最近 Session 输入时间、工作记录更新时间和当前状态。最近输入可能来自交接或自动化，不能等同于新的人类授权；工具日志不刷新这些时间。运行中、近七天、历史项分层排列，七天仅影响检索优先级。完成、暂停、取消和归档项按历史参考处理；空闲不等于完成，缺失状态或时间明确保留未知。

每次准备模型输入时重新读取。首次提供有界目录，优先当前会话、父会话和近期子／同级分支，再列其他近期候选，历史分支不会挤掉近期工作；默认最多16项、条目正文16,000字符，附省略数量。目录拥有独立的 `project_work_directory` 上下文槽：内容相同沿用已接受版本，条目或状态变化时只更新该槽，关闭时明确移除；原生上下文压缩后通过原有恢复快照恢复。项目认知文档独立更新，不因为每条目录变化重复提供。运行中的工具事件不会主动唤起模型或广播目录更新。

实际转交前用 `remotelab work directory --json` 重新读取完整目录，核对目标状态、时间、归属和版本，再沿现有工具与授权交接。API 为 `GET /api/work-awareness/directory`，通过当前 `runId` 或 `sessionId` 定位项目。目录未列出某项不代表不存在；来源故障不能当成空目录。父会话汇总还应核对已收到的跨分支补充是否实际处理，不能用“记下了”代替投递回执。

关闭 `directoryEnabled` 可停止后续输入的目录投影和子会话认知文档继承，已有群绑定、工作记录及可见看板保留。测试覆盖项目范围、父子继承、时间与状态、版本变化、关闭和压缩恢复；这些检查不代替真实对话中 Harness 是否正确选择并完成转交的行为验收。

## 运行中出现相关信息

双方的重叠提示来自同一批公开可查的 Session 记录，不按开始时间判定谁有权继续。面板给各方查看来源和核对的机会；模型可据当前目标、实际进展和增量价值起草参考建议。没有有用增量时无需发送。不会为了每次输入启动一个语义监听 Agent，也不会把普通新消息广播到所有 Session。

涉及另一 Session 的建议先保存草稿，完整写明来源、内容、可能影响及可核对的事件证据。来源 Session 中，人检查草稿后发送：

面向读者的说明先回答三件事：发现了什么，为什么会影响接收方的工作，需要人决定或做什么。`explanation` 的 `summary`、`relevance`、`nextAction` 各写一句短而完整的人话；函数名、测试日志、版本和技术边界保留在 `content` 中供展开核对。超过 240 字符的正文必须附简明说明。不要把 AI 整理的建议写成某个人的原话。

界面从接受的原需求记录读取来源入口、具体对话、作者及消息发送／接收时间，分别显示建议整理时间；不知道的入口与时间保留未核实状态，不以 Session 最新发言人补齐。`sourceRefs` 可引用至多八条确切的 `sessionId`／`requestId`，用来标明另一群或对话的原消息。链接显示对话名称并在新页打开。来源侧显示是否同步，接收侧显示是否采用；已变化的旧建议保留可读记录，隐藏过期确认动作。

资料与协作建议在标题和条目中明确区分。建议先讲发现、为什么与你有关、现在要做什么，再显示来源、目标和时间。同步确认在来源对话完成，采用确认在接收对话完成，新开工作对话明确写“新开对话”。已同步、已采用、已拒绝和已过期的记录按当前状态说明下一步，不继续显示草稿阶段的发送请求；原建议的下一步仍在展开区保留。按钮只把确认文字放入输入框，不自动发送，也不覆盖已有草稿。

```text
确认协作建议 suggestion_<id> 发布
```

这一步批准送达参考。目标正在运行且原生输入可用时，参考携带明确的“尚未批准修改当前任务”标记进入该 Harness；其他情况留在可查收件记录中。不新开模型运行，不唤醒归档 Session，不替人回答正在等待的问题。完成竞态下的参考不能重新启动 Codex turn。送达是独立的输入地址，并按该地址去重。

接收方决定采用时，需要另一条明确人类输入：

```text
确认协作建议 suggestion_<id> 执行
```

拒绝时使用 `拒绝协作建议 suggestion_<id>`。没有回答不等于同意；继续原授权工作。草稿、发布、提交到运行、原生接收、确认采用、实际执行及成果验收是不同状态。工作完成报告保留证据，不由 Run 结束自动认定业务完成。已确认采用也不表示已经执行。目标收到新的普通输入，或相关工作版本发生变化，旧建议必须重新核对。

分流草稿可携带 `routing.mode`（`new-session` 或 `existing-session`）、具体 task、folder 和 name。创建草稿不实际创建或迁移 Session。人确认具体目的地及任务后，Harness 按现有 Session 创建／发送工具执行，再回收来源、目的地和结果证据。发给已有 Session 的参考发布与在其内改任务仍分别确认；新 Session 没有跨会话发布，直接在来源 Session 用“执行”确认草稿中的完整分流内容。此模块不替代现行业务授权或已有固定流程。

## Agent 使用入口

### 个人试用：开工严格检查

可让自己的 Agent 执行：“在消息回复里为我开启／关闭开工严格检查，保留其他回复设置。”
设置页的“消息回复机制”提供独立开关，默认关闭；保存后跟随已核 Person 的 Web、飞书私聊、群和话题新工作。聊天中明确要求切换时，Agent 使用 `remotelab message-replies strict-start on|off|status --json`；服务从当前运行的已接受人类 Request 核对本人，不以 CLI 的共享账号或调用方传入的 Person 为作者。切换带版本检查和请求来源审计，也接入现有设置使用统计。

多人可以在同一运行中补充消息，但不能共享个人开关和回复展示偏好。其他人的新消息按其本人配置取快照；同一人的接续、已接受请求的重试保留原快照。无法核对发起人时不继承前一个人的个人设置。

开启后，新请求接入层核验当前发起人与本人开关，再读取独立版本文件 `chat/prompt-assets/experiments/work-start/v1.md`。规则正文不放公共 AGENTS.md，也不逐人复制；个人档案只记录选择、例外和来源。既有无版本设置明确绑定 v1，未来版本应新增文件，不原位改变 v1；本次不新增版本选择 UI 或另一套开关。

实际规则版本、正文、SHA-256、个人配置 ID、发起人与原请求／Session 来源冻结在 `messageReplyPolicy.strictStartRule` 中，再由每轮 `strict_start_check` 槽位投影。相同发起人的运行中接续和重试保留原快照；换人发起的新请求按其本人设置捕获，不改写原工作的归属。关闭、未配置、身份未知或不匹配时不读取或注入正文。规则缺失、版本未知或快照校验不符时保留正常回复设置并说明规则不可用，不借用其他版本或前一人的正文。

没有规则快照的旧工作不自动迁移；接续时保留原始已接受记录，按需查询原规则证据，不静默采用当前版本。本次不重建历史会话、不按人拆分执行。关闭或换人时明确替换当前规则，但无法从共享模型历史中删除已看过的正文；因此这里保证后端选择、加载与来源记录，不宣称模型记忆的硬隔离。

回滚只需关闭“开工严格检查”并保存，或在原对话明确要求 Agent 关闭。首条文字、清单和进展选择保留；新工作恢复普通开工，已经接受的工作保持原设置快照。此开关不代表频道看板、宠物入口或双群自动协作已交付。

```sh
remotelab work context --query '当前目标' --json
remotelab work start --goal '具体工作目标' --object '文件路径或业务对象 ID' --project '候选项目 ID' --json
remotelab work people --query '引用完整姓名所指人员的建议' --json
remotelab work suggest --file suggestion.json --json
remotelab work explain --file explanation.json --json
remotelab work review --file review.json --json
remotelab work update --file update.json --json
```

默认使用当前 `REMOTELAB_SESSION_ID` 和 `REMOTELAB_RUN_ID`。写操作归属接受该 Run 的已核人类 Request；请求体不能替换作者。证据序号须存在于来源 Session。CLI 不能批准自己的建议；批准只由原聊天输入办理。`expectedVersion` 防止覆盖另一条更新。

更新示例：

```json
{"workId":"work_...","expectedVersion":1,"status":"completed","result":"完成了具体修改及验证","evidenceRefs":[123],"artifacts":["成果路径或链接"],"methods":["已核方法入口"]}
```

建议示例：

```json
{"targetSessionId":"...","purpose":"overlap","explanation":{"summary":"另一边取消开头消息时，最终答复可能发回群主线。","relevance":"接收方正在改回复样式，也会影响同一条回复的位置。","nextAction":"先核对接收方最新实现；如果风险仍在，再确认同步这条发现。"},"content":"具体代码与隔离测试依据","impact":"仅同步给对应工作对话作参考","evidenceRefs":[123]}
```

给已有建议补上简明说明使用 `work explain`：提供 `suggestionId`、`expectedVersion`、`explanation`、当前 Session 的读取证据 `evidenceRefs` 及可选 `sourceRefs`。该入口仅为当前已核请求者所属的建议增加有作者、时间和请求来源的说明，保留原文、整理时间、发送与采用状态；不会发送参考、改变任务或让过期建议重新有效。源记录和当前读取会话分别留痕。

`GET /api/work-awareness` 将未核对的 `candidates` 与可展示的 `related` 分开，并提供记录和共同背景；`includeBackground=false` 供面板只读工作索引，避免重复加载背景。`/people` 提供涉及人物的必要规则；`/start`、`/update`、`/suggest`、`/review` 是有限写入口，没有批准 API。`review.json` 包含 `items`（至多三项，各含 `sessionId`、`workId`、检索返回的 `fingerprint`、`relation` 和具体 `reason`）及本轮 `evidenceRefs`；`relation` 为 `overlap`、`dependency` 或 `reuse`。空 `items` 是有效结果。

## 代价、恢复与验证边界

没有新增前台模型调用。默认上下文只读取必要配置与指针，不等待工作或记忆检索；显式查询采用有限本地异步 I/O，独立来源并发读取。后台学习继续复用已有轮后评审。工作查询基于温热的 Session 元数据，查询代价仍随已登记记录数量增加。每 Session 最多 64 项工作、64 项建议、最近 8 条输入及每工作最近 8 条结果。人员每次最多读 8 份、每份最多 128 KiB，命名投影约 3500 字符；公司文件最多 32 KiB、相关章节约 1800 字符；这些预算适用于显式查询，默认输入不携带相关工作投影。预算按完整条目削减，未投影的重要来源有提示。公司适用判断和词匹配是有限启发式，不是全语义检索。

记录以 Session 的 `workAwareness` 为唯一持久状态，`work_event` 为审计来源；查询和面板是派生视图，项目主账仍保持原位置。元数据更新在现有串行变更机制中完成，不另建跨实例锁或占工租约。审计追加失败返回 `auditError`，不能靠重发改变已提交的决定。发布已存而未留原生收据时，以收件记录为准，不盲目重试。部署前启动的旧 detached Harness 保持其原运行版本；没有声明防护协议的旧运行只接收可查的参考记录，不注入原生输入。新轮从当前源码构建上下文。

隔离测试覆盖同时开工与双向检索、草稿／送达／采用边界、版本冲突、结果回收、多人引用的姓名与适用范围、普通问法与公司背景、更正／损坏／缺失／超预算、UI 仅填人类草稿、原生输入去重与问题保护。原生测试使用可控模拟 Harness，可以证明传输和状态保护，不能代替真实模型在全部语言情境下都遵守规则。正式效果还要观察实际回答、漏检、误报、读取延迟和上下文开销；不通过向真实群发测试消息来验收。

## 群分流试点与个人执行安排

个人 v2 试用由当前 Harness 结合原讨论，判断输入是在提问、讨论、形成决定、明确交办、补充还是停止，再选择在哪里做、如何推进。平台不增加前置语义分类模型。简单答复不等待全局检索；快慢和并行由依赖决定。讨论已有明确执行决定时，携带目标、结论、约束、来源和验收要求直接开工；讨论充分、引用建议和沉默都不能单独授权执行。

A话题混入疑似B内容时，先判断它是对A的补充、明确改目标，还是属于B的独立内容。不能仅因最新消息提到B就改写A的目标、假设和验收标准。明确属于B的内容保留原来源，按已有确认边界交接；归属不清时查必要原件或只问归属问题。A中不受影响的工作继续，只暂停确实依赖歧义输入的步骤。这里的判断保护工作准确度；可选并行确认则只影响执行方式，不能阻塞已授权开工。

实例只配置获准的人与群，个人还须选择 `routing=experimental`；两层条件均满足才启用。旧请求保留原快照，不重放。

```json
{"version":2,"enabled":true,"trialId":"personal-execution-v2","personIds":["person_example"],"crossGroupSync":true,"groups":[{"sourceRouteId":"bot-route","tenantKey":"tenant","chatId":"chat","folder":"/absolute/workspace","activatedAt":"2026-10-15T00:00:00.000Z"}]}
```

`remotelab message-replies routing status|on|off --json` 按当前接受的人类请求核对本人，保留其他回复设置。群范围不从个人开关推断。新建和明确接续仍限同群；`sync` 可以经人确认在同一 v2 试用登记的群之间传递参考、复核并回传，不跨 Bot／租户。其他人不能代为确认本人的草稿；确认时说明目标展示和来源回传范围。同步复核不自动允许修改目标原任务。

### 讨论转开工确认卡

可交给当前 Harness 的请求：

> 当前讨论已形成具体工作。仅在主动参与模式下判断是否值得提开工卡；使用已登记的项目关系确定干活群，展示目标、已定方案与范围、来源、未决项、目标群和验收。由人在原生问题卡选择移交后才创建工作话题。其他选择继续留在原讨论。

本入口不依赖个人分流试点或群名，不启用通用新话题自动分流。主模型结合讨论判断是否提议；平台不另调用分类模型。连接器配置的 `projectLinks` 已有 `projectId`、`discussionChatId`、`workChatId` 和显示名称，开工复用这份明确关系，不接受工具请求指定任意目标群。连接器配置从当前实例标准目录或 `feishu-bots.json` 已登记路径读取；缺失、重名或没有对应关系时明确报不可用，不猜目标。不需要开启旧 `handoffCards` 或个人 `group-routing-pilot`。

`remotelab work kickoff --file <JSON绝对路径> --json` 使用当前 Run；追加输入带实际 `sourceRequestId`。提议包为：

```json
{
  "action": "propose",
  "goal": "要完成的具体目标",
  "plan": "已定方案、执行范围和约束",
  "sources": "可核对的原讨论与资料来源",
  "unresolved": "尚未解决的问题；没有则写无",
  "acceptance": "怎样判定交付可用"
}
```

返回的 `question.title` 和 `question.options` 必须完整交给 Harness 原生提问工具（不要重写或截短预览），现有飞书原生问题卡负责显示与回调。三个选择是“移交干活群并开工”“继续讨论”“暂不开展”。工具调用只能提出草稿或恢复已批准工作，不能批准。仅原提议输入的已核本人对完整预览的后续原生回答能批准；无回复、表情、Agent 自己调用 API、其他人点击、已过期或被新版替换的卡片都不会开工。没有实质变化的同一方案不会重复提卡；继续讨论或暂不开展后再次提交同包仍返回原决定。

提议、确认、待发送话题出队、执行启动分别读取现有参与状态。来源话题和目标群须为 `active`；`listening` 的单次邀请不能提开工卡。保存参与状态 epoch，期间切换后即使恢复 active 旧确认也不恢复，新方案需要重新展示。状态文件由参与控制器维护，开工模块只读，不新增第二份状态。

人确认后，`workAwareness.kickoffs` 保留原预览和人类输入，现有 `executionPlans` 承接一个工作分支。先创建对应干活群的独立 Session，再经持久 outbox 发布真正的话题；收到实际消息回执、绑定目标 Session 后才提交任务。原讨论收到实际话题入口，分支成果沿原计划回到原讨论验收。话题发送失败或结果未知时保持未启动，不能退回网页执行或重新创建；先核原投递回执，用现有投递恢复操作恢复同一投递。`{ "action":"resume", "proposalId":"kickoff_…" }` 只补做已有批准的创建/受理；重启会恢复已批准但尚未创建计划的情况。已切换模式的旧方案不能借 resume 复活。

维护与集成：`chat/work-kickoff.mjs` 提供提议、完整问题绑定、确认和恢复；`chat/session-manager.mjs` 在服务器读取原生待答问题后派生决定，不信任请求体的批准字段；`chat/work-execution-plans.mjs` 复用已有创建、回执启动、分支结果与主话题回收。已登记讨论群的主模型提示明确调用上述入口并原样展示问题（仅主动参与时提议），不能把既有 `work plan start` 或 `route new` 当成本功能的确认替代。

隔离验收：`tests/test-work-kickoff.mjs` 覆盖三选项、去重、其他人、旧卡、模式变化、未登记、未知/失败回执和恢复；`tests/test-work-kickoff-runtime.mjs` 用假 Harness 与假飞书提供方串起真实原生问题、卡片回调、服务器受理、实际回执绑定和子任务执行。均使用 `run-with-clean-instance-env.mjs`，不向真实群发测试消息。真实模型的提议时机和部署后的真人卡片交互仍需主话题验收。

### 分工、人的选择与主话题回收

`work plan --file <JSON> --json` 复用原 Session 的 `workAwareness.executionPlans`，不另建项目主账。写包的 sourceRequestId 必须指向本次执行实际接受的人类输入。`work context` 返回计划、分支、运行/排队/等待状态及 pendingQuestion。

| action | 数据与行为 |
| --- | --- |
| record | understanding、intent、where、approach、reason，记录有实质影响的归属和执行取舍；闲聊不用逐条记录 |
| propose | goal、context、reason、branches；每条含 id/name/task/writeScope/dependsOn，1–4条并按依赖排序，不允许环。context保留原结论、来源、限制、验收要求。只建草稿，不创建Session |
| approve | planId、expectedVersion、selected、approval。先展示完整方案，异步征询选择；必须对应草稿之后同一人的新输入。代码核作者、后续输入、版本和依赖；Harness负责核对具体同意及最新工作进度，不能靠沉默、无关输入或自己的话批准，也不能重复启动原话题已做或正在做的内容 |
| start | 与propose相同，另含authorization；一项明确交办可直接启动，多项需executionMode:"parallel-sessions"，authorization说明当前人类指令已明确要求这些具体任务并行。原始输入留存，Harness核语义；不能把Agent自拟分工或转发引用当授权 |
| continue | planId、expectedVersion、selected、text；人的明确后续交办接续已结束但未停止的分支，复用原子Session、保留上轮结果并重新汇总。不能恢复停止分支或打断正在运行的父汇总 |
| amend／stop | planId、expectedVersion、selected、text；只向选定分支传达本次人的补充或停止。运行中的补充用amend；已结束分支的明确后续交办用continue。取消请求发出不等于停止完成 |
| answer | planId、branchId、questionId、text；先核当前待答问题，转交人的原答案，不能替人做授权决定 |
| resume | planId；恢复同一计划未完成的提交，不能恢复已取消计划 |

本试用中的多项任务“并行”指独立RemoteLab子Session：每条都有可打开的工作入口和持续上下文，主话题负责汇总。原生子代理、并发工具调用或同一会话分段处理不能代替这种交付。人已明确交办具体各项并要求并行时，使用start创建对应子Session并报告实际链接，不再询问同一授权；Agent额外建议的拆分才走propose/approve。引用他人的旧指令不自动构成当前开工授权。

开工或新增独立交付时，当前Harness在大量执行之前判断一次工作归属与安排；普通追问、纠正和催问直接接续。有两个以上可分别验收、各需实质调查或执行、无需互等且冲突可隔离的部分，并行能减少等待或隔离上下文时，应主动提出具体分工，不能仅因单人也能完成而跳过建议。只读业务调查可以提出执行安排建议；建议并非修改业务代码或配置。简单列表、同一成果的连续步骤、产品功能中提到Session或引用别人要求并行，不能自动作为拆分或启动依据。有实质取舍时复用record简短留理由，不逐句登记，不另加前置分类模型。

并行方案要说明各分支的任务、依赖、修改范围及主话题汇总责任。同文件写入应串行或隔离工作区。Agent额外建议的并行是可选优化：保存草稿并使用异步原生提问后，立即在原话题按不分流的默认方式推进已授权工作；没有异步工具时保留建议，不调用阻塞式工具等待可选决定。不设置等待窗口，不从未回复推断同意，不创建未批准的分支Session。默认继续原任务不需要另建串行方案。

人可以选全部、部分、串行或不拆。迟到的确认先核最新进度，仅移交仍适用、尚未执行的部分；正在执行的部分先完成或明确交接，避免两处重复执行。失效草稿用stop撤销，范围变化则按剩余工作重提方案；原任务完成后无需再拆。明确选择分支Session串行时，先改成带依赖的新方案。创建位置由工作关系决定，propose/start 的 `branchSurface` 默认 `web-silent`：后台子工作仅创建网页Session，飞书保持原主话题作为唯一沟通入口，子工作的问题和结果回主话题。人要求另开独立沟通话题时明确使用 `feishu-thread`，在当前群新建话题并关联执行Session，等真实投递回执绑定后启动；该模式的问题留在分支话题，不再向父话题重复提问。方案context和展示须说明入口，Harness结合上下文理解“开session”，不能仅凭来源为飞书就选话题。已保存计划保持原surface；没有该字段的旧后台计划继续静默执行。当前WorkPlan仍只接受试点飞书人类输入。主话题继续协调、验收和汇总，不复制完整聊天。创建Session和提交请求使用稳定标识，重试不重复开工。停止在会话创建或开场排队期间到达时，迟到的创建结果不得继续开场或启动分支；尚未发送的开场取消。执行可能先于启动回执结束；迟到回执只补运行标识，不把分支或汇总的终态退回运行中。平台版本检查不能替代Harness对原话题实际进度的核对。

独立根分支并行，依赖方等前置返回可用结果再开始；失败、取消和空结果阻断对应依赖，其他分支继续。结束后主话题排队一次核验汇总，仅核对已有成果、证据、冲突和缺口，再通过原回复地址交付；模型执行结束不等于业务验收。整个计划停止后不再唤起主话题。停止会取消该分支已接受的执行请求，不碰无关运行；外部训练或设备作业仍须用业务工具核对，不能从Agent停止推断外部作业停止。

分支问题经持久出站队列回到主话题，注明分支；主话题读取pendingQuestion后转交对应答案。结果与等待状态来自请求和原生运行记录；启动恢复复用原计划与回执，不另建轮询任务。

飞书分支先把话题原帖写入持久出站队列，实际送达并绑定到子 Session 后才启动执行；待投递、失败或送达不明时保留原分支，不能静默改成网页执行。回执驱动继续执行，启动恢复复用同一投递，不新增轮询任务。受理通知返回原话题，优先给实际飞书话题链接；飞书只返回消息 ID 时明确链接暂缺，不伪造话题 ID，也不用网页链接替代。同次就绪的分支合并通知，后续就绪的分支再补入口。分支中的追问沿话题绑定回到同一 Session；已创建的历史网页分支不自动迁移。回执批次先保存再投递，重启或重试不重复发送；仅有草稿、未选分支和未启动依赖不会显示成已经创建。投递入队仍需连接器实际送达，不能当作业务完成。通用session-spawn的可见创建通知也沿调用Run保存的回复地址回传；Web调用和隐藏子会话不会因旧群绑定而向飞书发通知。

维护入口：`chat/work-execution-prompt.mjs` 生成给当前试点请求的 Harness／Agent 读取的分工指引；`chat/work-execution-plans.mjs` 保存计划并执行分支创建、依赖与回传；`chat/source-deliveries.mjs` 以投递回执触发话题绑定后的接续。它们是内部提示与执行机制，不是给群成员阅读的计划文档。渠道要求需同时更新提示、实现和测试。

验证入口：`tests/test-work-execution-plans.mjs` 覆盖个人/群范围、跨群确认、草稿、部分选择、依赖、失败、空结果、补充、提问、停止和恢复；`tests/test-group-routing-runtime.mjs` 通过真实受理与隔离假执行器验证子任务完成、主话题核验和原地址出站。话题投递回执、原帖绑定、失败不启动、重复回执与停止后不启动由隔离测试覆盖。隔离回归不证明真实模型理解所有语言情境；真人试用继续看漏接、误开工、耗时、重复解释和人工跟进负担，不以转接次数代替效果。

### 原 v1 单群试点兼容

`<CONFIG_DIR>/group-routing-pilot.json` 是实例本地开关，不随代码默认开启：

```json
{"version":1,"enabled":true,"groups":[{"sourceRouteId":"bot-route","tenantKey":"tenant","chatId":"chat","folder":"/absolute/workspace","activatedAt":"2026-10-08T00:00:00.000Z"}]}
```

三个身份字段必须同时匹配。启用时间以前的消息保留原路径；未知时间的历史重放不进入试点。仅新增的人类飞书输入可用，自动任务、其他群、其他 Bot 和 Web 入口不获得此权限。关闭 `enabled` 停止新增分流和确认，已经接受的工作按其原话题继续，已确认复核的回传保留。不要删除 Request、Session、投递回执或重放旧群消息。

试点把消息接收、事项归属、执行位置、回复位置与展示分别保存。运行中的群主线可接收兼容的人类原生追加，每条输入保留作者、消息地址和自己的处理回执；共用执行不意味着同一业务任务或共用最终正文。主线 Harness 尽快确定去向，核对作者、授权和目标状态后把深入业务检查交到工作话题，不先做完整研究再分流。工作话题也可接收原生补充。Jev 仅异步选择社交表情，工作位置由主线 Harness 判断，不再由 Jev 同时新开话题或判断参与控制。人工静音、暂停、状态卡和明确命令仍独立生效。关闭开头展示不会清除已经选定的回复位置。

Harness 用 `remotelab work route --file packet.json --json`：

- `mode: new`：`task`、`reason`、可选 `name`。先校验并预留话题，再提交原作者输入；重试复用目的地。
- `mode: continue`：还需 `targetSessionId`。原文和附件进入原工作话题，主线不再重复答复。可选 `requestIds` 只能来自同一次正在执行的群输入；已经有可见正文的输入不可静默搬走。
- `mode: handoff`：跨群任务转交草稿，需要 `targetSessionId`、`task`、`reason` 和可选 `requestIds`。原文和附件来自来源 Session 内同一已核作者的已接受输入；允许把已经在原处答过的误发内容明确转交，但不静默搬走。返回 `preview`、`question` 及手动确认／拒绝字符串。Harness 把 `question` 原样交给原生提问工具，题目展示具体目标群／话题、原文与附件、限定任务及回传范围，按钮为“确认转交／暂不转交”，不需要复制内部编号。服务端把完整预览与不可变草稿核对后解析选择。本人点击后才发送；只识别误发、Agent 判断、沉默或其他人的回答都不能批准。目标状态或范围变化须重新核对草稿。目标收到原作者交办并在目标话题答复，系统将接收回执和处理结果回传来源；发送失败不冒充已转交。
- `mode: sync`：还需 `targetSessionId`。`task` 是具体新信息及需要复核的问题，`reason` 解释影响。只保存草稿，先向人说明目标、内容和边界。人在来源对话输入返回的 `确认同步 sync_...` 才提交；`拒绝同步 sync_...` 拒绝。没有 Agent 批准命令。

个人试点常驻一份已登记项目／群的简短目录，不读取其他群聊天。`work discover --query <具体事项>`（`GET /api/work-awareness/discover`）按已有工作摘要查询最多三个候选，只为命中项读取历史元数据，返回群归属、时间、当前状态、匹配的旧工作状态、入口及转交条件；旧工作完成后又有输入时，不能把旧完成标记当成当前话题状态。未命中不证明工作不存在，归档或已结束项默认只是历史参考；目标是否仍适合承接由 Harness 阅读必要原文判断。发现目录不会扩大试点范围。

确认按钮的数字选择由服务端按当前待答问题解析，保留真实作者、选择和时间；不信任 Agent 提交的批准布尔值。原生确认和直接输入完整确认字符串使用同一校验及去重入口。`handoff` 保留不可变原文集合，重试复用同一目标 Request；已有本人确认但受理或回执失败时，用 `{mode:"handoff",proposalId}` 恢复同一包，不重新询问同一授权；该入口拒绝未批准草稿和任何内容／目的地修改。跨群投递使用目标群地址，不继承来源群参与状态。目标有其他执行时排队，不代答该执行的问题。`work context` 中 `admissionDeliveryState`、`returnDeliveryState` 分别表示接收回执和结果回传的投递状态，队列受理不等于送达或业务完成。

原生追加工具沿用根 Run 的环境时，`sourceRequestId` 必须选取该执行中实际接受的输入；不能借其他 Session 或未进入当前执行的输入授权分流。

主线回复统一使用一份回复决定：正文、可选表情、回复位置、覆盖的输入，以及明确不发正文时的理由。主模型在最终答复前写 `<private>feishu-response:{"replyMode":"thread","requestIds":["实际原输入ID","实际补充ID"],"reaction":"Get"}</private>`，随后给正文；只有原输入时可省略 requestIds。原生最终答复和输入处理记录一起提交，不再另调工具登记“已经回答”。开场只需选择 replyMode，后续沿已选位置回复。选择话题不授权另开执行或跨群转交。

需要在执行中立即回答独立问题时，可用 `remotelab work reply --file reply.json --json`，字段为 `{sourceRequestId,text,requestIds?,replyMode?,reaction?,noTextReason?}`。它调用同一回复实现，不是第二次回执；同一答复只能选一个入口。相关补充共用一答，独立问题分别答；表情贴在该答复所归属的原消息上，正文留在已选话题。没有正文时保留理由和可选表情，不另发状态说明。开场和进展不阻止后续合并答复。

回复发布前验证所列输入确属同一执行和群，保留各自作者，拒绝已经移交、已由另一答复覆盖或不存在的输入。整份决定先持久保存，再恢复各输入记录及唯一出站消息；重启不重复发，也不凭正文猜测输入归属。实际是否回答完整仍由 Harness 判断。未列入的追加不会自动套用根输入的答案；遗漏处理继续在内部记录为未完成，不自动向群发送“未保存分流或独立回复”的程序回执，也不把模型的空答复解释成所有输入都已处理。原协议和既有投递不重放，非试点对话保持已有回复归属，群模式与个人分流范围不因本次重构扩大。

逐条回复契约在接收时保存为 `routingPilotMainlineProtocol: 2`。升级前已经接受的输入/运行沿用原契约，新输入不会 steer 进没有此契约的旧主线运行；重试保留原快照，不重放历史消息。

`sync` 的确认只授权该信息的有限复核和结果回传。目标复核排在当前工作之后，不插入活跃执行、不代答原问题、不自动修改原任务或执行新业务操作。排队期间目标任务改变会终止过期复核并回报来源。成功复核后，目标话题展示已确认的信息、来源及复核结论，并把结果写回来源投递队列；失败或过期只回报来源，不在目标公告采纳。`work context` 中 `routing` 提供来源、目的地、草稿及回传状态：`submitted` 表示已接受，`return-queued` 表示结果已进入发送队列，`targetDeliveryState` 与 `returnDeliveryState` 分别跟踪目标展示与来源回传，`delivered` 才证明对应送达；三者均不等于业务采纳。

同步回传沿用来源工作执行已经选定的回复位置，原生确认回调不会把话题改回群主线；人在已有话题确认时保留该话题。复核结果卡默认收起完整正文、表格和未决问题，首屏显示原结论摘录及原工作入口；失败原因在折叠区外可见，已经取得的部分依据与未答问题仍完整保留在详情中。展示摘录不决定工作归属，也不删减正文。无法完整表示或明确被飞书拒绝的详情卡转为完整 Markdown 文件，不回退成主线长文；发送结果未知时保留原去重保护。

飞书折叠面板不支持原生表格，因此折叠区内按行展示表格，每格保留列名和完整内容；普通展开答复仍使用原生表格。原生同步确认只更新原问题卡，不再另外发送成功状态正文；按钮与已回答内容不展示内部同步编号。Harness 收到系统处理回执后不再重复发送仅确认受理的 final，复核完成由系统回传一次。必答问题、新的实质答复及失败仍分别展示。重复确认、控制服务重启或回传入队后丢失回执，均复用原接受记录和出站内容，不重新贴全文；已经送达的历史消息不会自动批量修改。以上不改变个人开场、清单及进展设置。

原工作入口在已有飞书话题 ID 时直达该话题；只有消息 root ID 时使用可访问的 Session 入口，不把消息 ID 拼成无效的话题链接。

该试点不增加前置语义分类模型。主线接收和目标执行各有自己的必要调用；明确接续不等待后台相关工作检索，跨话题复核异步排队。实际响应速度仍需用真实输入的接收、分流、目标接受、首次回复送达时间测量，不能用本地回放耗时替代。

验证入口：`tests/test-confirmed-handoff.mjs` 验证有界发现、拒绝／过期草稿、真实原生数字确认及交接回传；`tests/test-group-routing.mjs` 检查归属、范围、拒绝、重复确认、过期和恢复；`tests/test-group-routing-runtime.mjs` 使用隔离假 Harness 验证接受、执行、完成钩子和回传队列。既有飞书回复、原生追加、参与状态和任务卡测试覆盖兼容性。真实群只由获准试测的人发送测试内容。

For explicitly selected recurring work, the [automation home](task-center-v1.md#stable-automation-home-explicit-opt-in) is a stable task-context branch with source/task links and durable definition revisions. It records source lineage but does not inherit the source transcript, model context or agreements; older full-history homes can be explicitly replaced while retaining their history. Individual execution Sessions point back to that home. Reading status does not send a message to the worker or queue behind its active Run. Discussion references supplied with an adjustment are retained as reported provenance, not verified authorization.

个人 `routing=none` 限制自动转交工作 Session，不限制主模型在群主线首个可见回复前选择话题回复。话题回复标记不会自行创建独立工作 Session；已有可见投递继续锁定原位置。另开或接续工作 Session 仍遵循本条输入的授权与分流策略，表情不参与这两项选择。

### Personal trial controls on Feishu group cards

A v2 pilot may explicitly set `personalOptIn: true` and a `scopeLabel`. This opens eligibility only in its registered route/tenant/chat tuples; each sender still needs their own confirmed `routing: experimental` preference. Existing allowlist pilots remain unchanged. Group cards show personal enable, disable and status buttons in both layouts. The signed callback validates the current card/chat and derives the Person from the clicker’s route-scoped Feishu identity; card payloads cannot nominate another Person. Unbound users are asked to send a message first. Changes reuse the existing personal reply setting, preserve other preferences, and affect subsequent accepted inputs. Shared cards do not display one member’s state as a group state. Child Sessions currently open on Web; the original Feishu topic remains the coordination and acceptance entrance.

With explicitly authorized `publicRoster: true`, group cards display the pilot-wide list of enabled People (not the membership of each chat). The information routing section uses one purpose sentence, the roster, three personal controls and collapsed scope/rules. Changes to the existing personal settings file trigger a coalesced refresh of registered trial cards, including groups outside project-memory registration. Refreshes only patch existing messages; they never create replacement cards or change top notices. A failed patch keeps its failure visible in connector logs instead of silently sending a new message.

## 群内交付审阅与反馈回传

对 Agent 说明：“把这份成果发到指定群请大家审阅，把与这次成果相关的反馈带回当前工作。”发送前应明确目标群、实际正文和反馈范围；尚未获得这三项授权时先展示具体内容请人确认。普通分享、旧群消息、同项目标签不会自动建立审阅关系。

| 用途 | 谁继续负责工作 | 群主 Session 的作用 |
| --- | --- | --- |
| 误发任务转交 `handoff` | 经本人确认的目标话题 | 核对去向后交接 |
| 参考同步 `sync` | 两边保持各自工作 | 对已批准的信息复核影响 |
| 并行子任务 `plan` | 主话题验收，子 Session 承担明确分工 | 汇总分支结果 |
| 交付审阅 `delivery` | 发出成果的原工作 | 阅读、解释、讨论，选择相关反馈回传 |

群主不是被绕过的收件箱。已知事实可直接回答，意见含糊时先讨论，缺陷、修改意见、验收结论或需要原上下文解决的问题应及时回传。可以一边在群里解释，一边回传；无须机械三选一，也不要求每条发言都回复。回传保留各人的原文、作者、附件、群内已答内容和未解决事项，不要求人再次去原工作喊“读一下群”。

实现复用 Session 元数据、消息 outbox、Request 队列与完成回执。`work delivery --file <JSON> --json` 有三个操作：

- `publish`：`key`、`chatId`、`text`、`scope`、`authorization`。Harness 核对当前真实人类指令确已授权发送和反馈回传；`authorization` 记录依据，不是新的批准按钮。服务端从当前输入固定原工作、作者、Bot 和租户，只能向已登记群发送。相同输入与 `key` 重试复用原正文及发送队列，修改内容会拒绝。初版发送文本（可包含成果链接），不隐式复制附件或整段私有上下文。实际发送回执中的消息 ID 才建立可用的反馈入口；未知或失败状态不宣称已送达。回执晚于成员反馈写入时，取得真实消息回执后仍可接收该发布建立以来的相关反馈，不把回执写入时间误当成发送时间。
- `feedback`：`originSessionId`、`reviewId`、实际 `messageId`、`requestIds`、`reason`、`handled`、`unresolved`。只收本次执行实际接受的该群人类消息，最多八条，支持多位作者。语义关联由当前 Harness 判断并说明依据，工具验证消息来源和已发送的审阅关系；不能把任意群消息自动归入。群主仍保留本地答复责任。重复或交叠输入不会再次开工；丢失受理回执时重试同一包，原工作按既有队列接收，不拿反馈回答正在等待的人类确认。
- `close`：原发布人从原工作提交 `reviewId`、`expectedVersion`、`reason`。关闭后不收新反馈，也不启动尚未准备的反馈处理；已经运行的处理不被冒称为取消。需要停止正在执行的工作仍走原停止入口。

原工作收到反馈后结合已有上下文处理，只继续既有授权内的工作；暂停或停止的任务不因反馈恢复，新增要求或冲突决定交有权人判断。同一发布下的原始消息即使从不同群 Session 再次回传也会去重。结果回原工作入口；不会自动再次发到审阅群，也不会自动另开工作或转移群绑定。群主下一次处理消息时能读到反馈处理状态，但不自动获得原工作回复的正文；处理结束不等于反馈验收通过。是否再向群里解释、需要哪些可公开内容，由群主结合授权判断。没有后台群监听器、定时扫群或新增分类模型；现有群参与设置仍决定哪些输入交给 Harness。每群最多保留八项打开的审阅，更多成果应先结束旧审阅。

`work context` 的 `deliveryReviews` 可读发送、反馈受理、处理结果及关闭状态；自动上下文只带关联元数据和摘要。普通工具已发出的旧消息暂不自动补绑定，需要明确来源与新的授权后再处理，不能把未知来源猜成原工作。隔离测试 `tests/test-delivery-review.mjs` 覆盖实际回执、归属不变、多作者与附件、重复/丢失回执、关闭及原生确认隔离；真实群发送及自然反馈效果单独验收，不由模拟测试替代。

默认主动参与的连接器配置与开工接口共用同一默认值；显式旁听、暂停和禁用设置仍保留。参与模式变化阻止尚未启动的开工，但不取消已完成工作的主话题结果回收。一般自动新话题分流保持暂缓；消息长度和工具调用本身不构成另开话题的依据。
