# 发布通道与部署

核验日期：2026-10-06。已完成的是接口选型、适配器和无账号验证；真实账号登录及公开发布必须单独验收。

| 平台 | 选定通道 | 选择依据 | 一次性绑定 |
| --- | --- | --- | --- |
| X | Buffer GraphQL API | 官方发布服务提供文本、串文、原生定时、post 状态和外链；不要求请求者申请 X 开发者应用 | 本人注册或登录 Buffer，连接指定 X，创建 API key，在本实例绑定页填入并选择已读回的账号 |
| 小红书 | xpzouying/xiaohongshu-mcp v2.5.5 | 项目已提供图文、二维码持久登录、本人资料和详情查询；使用当前创作者网页自动化，不自行逆向签名 | 本人用小红书 App 扫绑定页二维码，页内读回身份后确认该账号 |
| 知乎 | 暂未接入 | 可选目标；尚无本实例验收过的文章发布与身份回读适配器 | 后续单独接入 |

Buffer 支持 X，支持列表没有小红书或知乎，所以它不能独自覆盖全部目标。[官方渠道列表](https://support.buffer.com/en-us/articles/connecting-your-channels-to-buffer-HvWLgAJvL9)。social-auto-upload 当前主线面向国内视频平台，本次文字消息分发不选它作为统一引擎。[项目源](https://github.com/dreammis/social-auto-upload)。

## Buffer

端点 `https://api.buffer.com`，POST JSON `{query,variables}`，请求头 `Authorization: Bearer <key>`。

- [认证](https://developers.buffer.com/guides/authentication.html)：个人流程可用 API key，不必注册 OAuth App；key 可访问其账号的全部组织，代码固定已选择的组织和 X channel。
- [读取账号与 channel](https://developers.buffer.com/guides/your-first-post.html)：`account { organizations { id name } }`；`channels(input:{organizationId}) {id name service}`。
- [发帖输入](https://developers.buffer.com/types/CreatePostInput.html)：`CreatePostInput!`，显式提供 `assets:[]`、`needsApproval:false`、`schedulingType:automatic`、`mode:shareNow` 或 `customScheduled` 与 `dueAt`。公开发布只能在用户授权后执行。
- [串文](https://developers.buffer.com/examples/create-threaded-post.html)：`metadata.twitter.thread` 包含根帖和所有回复，根帖等于顶层 `text`。
- [单帖回读输入](https://developers.buffer.com/types/PostInput.html)：`post(input:{id}) {id text status externalLink sentAt}`。创建记录不是发布成功。

免费／付费计划和 API 可用范围以实际账号为准，不在本次实现中自动购买订阅或充值。第一次绑定若账号不提供 API，则报告明确错误，核对官方可用路径再调整。

## 小红书

[上游](https://github.com/xpzouying/xiaohongshu-mcp)，锁定 v2.5.5（a5c8f7799980ba1fdd501999843eb2d17e4c9a9f）。linux-amd64 release 二进制实测 SHA256：`a4e99322156e7a169466e793045dadc3306c0792db3eade603e030cc0c1c2e3a`。首次安装还下载其自带 Chromium，并按上游 SHA256SUMS 校验。它是社区网页自动化工具，不是小红书官方发布 API。

本机实测原版登录会在加载推荐流时等待整个页面 load，导致登录检查与二维码请求超时。配套 [xiaohongshu-login-ready.patch](xiaohongshu-login-ready.patch) 只修这两条路径：等二维码或本人导航元素出现，不等待整页素材，不插入固定 sleep。在 v2.5.5 源码上 `git apply <patch绝对路径>`，按当前 Go toolchain 编译 `go build -ldflags '-X main.version=v2.5.5-remotelab-login-ready' -o <独立后台二进制路径> .`。二进制、浏览器依赖和私有配置独立于共享源码。换上游版本后重新核对是否仍需要该补丁，不盲目套用。

每人一个私有工作目录和独立端口。环境文件权限 600，`COOKIES_PATH` 指向该人自己的目录，配置 `AUTH_TOKEN`；例如通过 `-port 127.0.0.1:18061` 保持 loopback。其他机器运行前查二进制 `--help`。实际端口、身份和密钥保存在本机私有 settings，不进入共享方法正文。

- GET `/api/v1/login/qrcode`：`data.img` 是 data URL；后台在二维码有效期内观察扫码并保存 Cookie。
- GET `/api/v1/login/status`：`data.is_logged_in`、`data.user_id`、`data.username`。绑定以稳定 user_id 为准，不只比较昵称。
- GET `/api/v1/user/me`：本人资料和 `feeds`，发布前记录旧 ID，发布后查新 ID。
- POST `/api/v1/publish`：`title,content,images,tags,visibility`，可选 `schedule_at`。v2.5.5 的成功响应没有 note ID，因此还必须回读本人列表与详情，不能直接说公开成功。
- POST `/api/v1/feeds/detail`：`feed_id,xsec_token`，返回 `data.note {noteId,title,desc,user,...}`。只核对目标笔记，不加载评论。

页面变化、验证码、Cookie 失效可能中断发布。保留待发内容与已有结果；需要本人身份验证时在绑定页处理，不在群里索要密码。二维码获取失败先记录具体错误，核对网络和浏览器依赖，不把“HTTP 200 发布完成”替代公开笔记验收。

## 一次性网页入口

`node scripts/binding-server.mjs --person <personId> --port <port> --auth-file <当前实例auth.json>`。先有独立监督服务，再使用当前实例 `remotelab preview expose` 公开受密码保护的路径。网页仅登录所指定 Person，不读取其他 Person 的绑定。页内依次完成小红书扫码、确认读回的账号，以及 Buffer key 验证与 X 账号选择。无账号时页面显示待绑定，发布 CLI 拒绝发送。

Node 18+；文字卡使用独立 Chrome headless 进程截图，不使用已有任务的浏览器档案。需要中文字体；脚本支持 `SOCIAL_PUBLISH_FONT_FILE`。服务进程使用严格目录权限。测试必须使用独立状态目录和模拟平台，禁止把随机测试文案发到真实平台。

`~/.config/social-publish/runtime.json` 可保存本机 `chrome`、`fontFile`、`libraryPath`、`fontConfig`，render-cards 自动读取，用户不必维护浏览器命令。定时超出平台范围时，先查当前实例 `remotelab trigger create --help`，使用 `--at <含时区时间> --conversation source --text <只发布该 manifest 的任务>`，任务内使用同一 source 与 jobId；创建回执单独留存，不把任务创建成功说成已发布。
