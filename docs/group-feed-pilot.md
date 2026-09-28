# 群对话试验

对指定飞书群设置 `groups[chatId].groupFeed: true`，并保留 `participationMode: "ambient"`。只改这些群的主线；其他群和话题沿用原来的路由。

## 目标状态

- 群主线进入由机器人持有的独立 Session，并显示在 RemoteLab 的「群对话」区，不归入某个人的空间或项目列表。
- 网页可以查看历史，但不能向这条 Session 发消息、取消运行、修改它或抢走群绑定。服务身份的 Connector 请求可以投喂。
- 网页继续普通的飞书绑定 Session 时，不再默认把答复送回群；要从 API 明确投递，必须提供本次请求的 `sourceDelivery`。
- 首次开启时创建一条新群 Session，原 Session 解除群绑定。这样旧 Session 中的网页私聊不会成为试验群的新上下文。
- 群主线不参与个人空间/项目分类，也不写入通用的个人记忆；夜间快照保存在群专属记录中。
- 每晚北京时间 23:30，服务端按事件位置增量检查已开启的群 Session，保存最近消息出处及现有 `workSummary` 到实例配置目录的 `group-feed-reviews/<sessionId>.json`。启动时补扫未处理消息；原始历史仍留在 Session。

## 开启与回退

确认群名和 chat ID 后，只在对应 Connector 的 `groups` 条目加入 `groupFeed: true`，校验配置并重启该 Connector。首条新群消息会完成新 Session 绑定；核对新旧 Session 的群绑定、只读入口及消息回执。

回退时将该群条目显式设为 `groupFeed: false`，重启 Connector。下一条群消息创建新的旧链路 Session，并解除试验 Session 的群绑定；不要删掉旧历史。未设置 `groupFeed` 的群始终走旧链路。

## 试验边界

群 Session 的提示词要求将需要查资料、运行工具或长期推进的工作交给独立工作 Session。当前这项工作分流依赖 Harness 判断，尚未成为工具层的强制限制；现场验收需核对它是否真的从项目工作区开工。夜间检查保存有出处的增量快照，不会自行改写已确认的项目知识，也不替代人工核对决定。当前版本尚未自动轮换超长的群 Session；长期轮换要在试验确认上下文交接与并发消息安全后启用。
