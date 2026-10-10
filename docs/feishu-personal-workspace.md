# 飞书侧栏的 Index 与 thinking

飞书 Web 助手新增两个入口，保留原导航、具身前沿和每日日报。Index 复用本人已有的飞书私聊 Session；没有私聊记录时创建一个可重复打开的个人 Index Session。thinking 是独立页面，其中包含待办、参与项目的既有日报、当前重点和“接着推进”。推进建议不另设侧栏入口。

第一次点击入口时连接本人的 RemoteLab 登录账号。连接页显示姓名并要求确认；连接限定为当前飞书网页来源和浏览器账号，切换账号会清除屏幕上的旧数据。连接可断开，30 天到期，只在服务端保存令牌哈希。新连接与既有消息设置连接分别授权、分别保存，原连接不增加权限。

个人入口只能读取认证 Person 的待办和 Index/thinking Session，不能传入他人的 Person 或任意 Session。项目参与依据本人工作和输入中的已确认项目关联；群项目、被提及或同名不能自动认定为本人负责。日报来自实例已登记的项目索引与现有 daily Markdown，原飞书链接取当日成功出版回执。缺少参与记录、来源不可读、日报过期或节选截断会明确显示，不填造数据。待办沿用 display 的原待办存储与读取器；副屏服务停用时仍可读取原件，不启动已停用的设备服务。页面不维护另一套待办或项目状态。

“开始分析”和“继续分析”将来源快照送入一个普通、可复用的本人 thinking Session，沿用 Index 的执行器与模型设置。界面只展示结果，不增加后台规划模型。每次提交有独立请求编号；网络结果不确定时先刷新核对，重试相同内容复用原请求。分析不会自动修改待办、恢复暂停工作、群发或启动其他业务。“与 Index 讨论”将分析放入 Index 的草稿，用户发送后继续同一段对话。

结果和执行记录保存在原 Session，打开页面读取最近的消息；执行时的读取观察有 30 分钟期限，关闭页面或切换账号就停止。已有分析仍可从对应完整 Session 查看，执行失败会显示原因。

源码为 `static/feishu-personal-workspace.js` 与其固定 background broker。部署到现有助手前，先取得 `build.mjs`、`manifest.json`、`message-background.js` 和 `content.js` 的新鲜 SHA-256，再运行：

```sh
node scripts/install-feishu-personal-workspace.mjs --extension /path/to/extension --expected /path/to/digests.json
```

安装器拒绝覆盖未知版本，备份后更新并重新构建。联调版本为 1.1.0；原已发布 1.0.0 安装包和更新源保持原交付流程。本次新增个人入口不改变普通飞书消息及网页成果的投递。
