# 飞书 Web 设置接入

话题运行状态、标题摘要与普通插件版本／更新维护见 [话题状态同步](feishu-web-topics.md)。状态连接使用独立只读权限，既有消息设置连接不自动扩权。

可将下面这段交给维护插件和实例的 Agent：

```text
请把飞书 Web 插件的设置整理为「页面显示／消息设置」。保留既有显示偏好、
原生消息、输入草稿和并行维护的模块。消息设置复用当前 Person 的回复配置，
包含首条回复、验收清单、进展展示、开工严格检查和实验分流；模型只影响当前
已关联飞书对话的后续消息。保存全部成功后收起，失败时保留草案并说明已保存
的部分。用隔离账号验证读写、账号切换和并发冲突，再核对部署与安装版本。
不要传输实例所有者凭据或代用户完成首次个人账号连接。
```

插件里的页面显示仍按原生飞书账号保存于当前浏览器；布局和宠物位置属于设备。
消息设置直接读写 `person-message-replies.mjs` 的同一份个人配置，因此网页、飞书
私聊、普通群和话题中的后续新工作沿用同一选择。实验分流仍受现有群试点限制。
模型修改复用 Session 的运行配置，正在执行的 Run 保留已接纳的模型快照；共享
群话题后续参与者也会使用这个对话的配置，Quick 对话保持创建后固定。

开工严格检查复用已有开关，不新增实验设置页。开启时，既有未标版本的个人配置
绑定规则 v1；请求接入层只为身份匹配且开启的发起人读取独立规则，并记录版本、
正文和来源快照。个人档案保存选择与例外，不复制流程全文。关闭和换人不会清除
模型已见历史，也不改写已接受工作的快照；加载与接续边界见
[个人开工检查](session-work-awareness.md#个人试用开工严格检查)。

首次使用从飞书「设置 → 消息设置 → 连接我的设置」打开独立账号连接窗口，
登录并核对自己的姓名后连接。此窗口不进入完整工作台。连接本身不激活或改变
回复设置。服务器只记录权限有限的随机凭据的哈希，凭据绑定实例、来源和当前
浏览器账号，30 天有效；可在原入口断开连接。原生浏览器账号只用于本地隔离，
不会被当成 RemoteLab Person 的认证证据；Person 来自本人的登录会话。

接入协议仅提供下列能力，不接受所有者／服务凭据，也不赋予文件或任务 API 权限：

- 认证连接页：`GET /page/feishu-web-settings/connect?origin=…&account=…&state=…`。
- 本人登录页签授权：`POST /api/feishu-web-settings/grant`，明确 `confirm: true`。
- 限定凭据：`GET/POST /api/feishu-web-settings/replies`，沿用个人回复的版本校验。
- `GET/POST /api/feishu-web-settings/runtime`，仅接受已关联的飞书 Session、目录中
  可选模型和其支持的思考程度。模型写入在元数据锁内检查版本，拒绝覆盖并发修改。
- `DELETE /api/feishu-web-settings/connection`：撤销当前连接。

请求以 `Authorization: Bearer fwset_…`、`X-Feishu-Origin`、`X-Feishu-Account`
标识连接；凭据不能用于普通实例 API。浏览器扩展通过限定目标和路径的后台
请求器访问接口；当前 Mac mini 联调助手注入的版本使用同一协议直接请求。
两个保存对象分别校验、分别写入；前一项成功而后一项失败时如实显示部分结果，
保持面板打开。未关联工作的话题禁用模型设置，个人消息设置仍可使用。

代码、隔离测试、服务部署、插件安装和本人真实使用分别验收。不要以连接记录、
模拟账号或已部署接口声称本人已经保存或完成飞书使用验收。

## Mac 本地增强试验的账号连接

现有独立 `Feishu Native Trial.app` 可复用 Web 1.2 组件；构建、安装和验收入口见
`scripts/feishu-native/`。既有 Mini 支持飞书 8.0.3 独立试验副本；独立安装器支持 M 系列、飞书 8.1.17 的已核内部构建，不能给正式 App
直接覆盖资源，不能视作支持任意飞书版本的通用安装包。

本机助手固定监听 `127.0.0.1:19342`。服务端仅额外接受精确来源
`http://127.0.0.1:19342`，不接受 `null`、其他端口、`localhost` 或局域网来源。
连接仍由本人在已登录的 RemoteLab 页面核对姓名并点击确认，票据继续按来源、
原生飞书账号和用途分别绑定。原生账号来自客户端本身的账号接口；不得复制网页
票据或借用实例所有者身份。浏览器回传页使用一次性随机状态，10 分钟失效；
本机 API 另需私有能力令牌，固定代理消息设置、个人工作区与只读话题同步操作。

当前导航复用 Web 组件并挂载在原生消息列表内部，最外层官方导航保留。源码构建
固定记录 Web 发布版本及 SHA-256，安装检查试验资源基线、保留原包备份、重新签名
并验证；新版本适配需要重新验证，不能直接套用浏览器扩展的自动更新器。

The same personal routing preference is also available from eligible Feishu group configuration cards. “为我开启试用 / 为我关闭试用 / 查看我的状态” resolve the signed callback operator to their own Person; they do not change group participation, other members, or already accepted inputs. Callback audit entries retain event/chat/message provenance, and repeated callback events cannot undo a later personal choice. See [the scoped trial contract](session-work-awareness.md#personal-trial-controls-on-feishu-group-cards).
