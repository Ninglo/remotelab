---
name: social-publish
description: 根据用户明确的发布指令，将会话里的文字和配图适配并发布到已绑定的小红书和 X，保存逐平台回执、避免重复发布，处理一次性账号绑定和发布失败。普通聊天、只写草稿或只查资料时不发布。
---

# 会话发布到小红书和 X

用户只需要在会话中给内容和发布意图，例如“把下面这段发到小红书和 X”。你负责整理内容、配图、执行、核对结果；已有绑定和本次发布授权不重复要求确认。账号属于当前请求者，按当前已核 Person 选择绑定，不能从 Unix 用户、Session 创建者或其他同事的登录状态推断。这个 Skill 可被正常自动发现，不要求用户记住 Skill 名。

## 执行入口

命令中的 `SKILL_DIR` 是本文件所在目录，使用它的真实路径。Node.js 18+，业务代码只依赖内置模块。

```bash
node "$SKILL_DIR/scripts/publisher.mjs" status --person <personId>
node "$SKILL_DIR/scripts/publisher.mjs" prepare --file <input.json> --out <manifest.json>
node "$SKILL_DIR/scripts/render-cards.mjs" --file <manifest.json> --chrome <Chrome路径>
node "$SKILL_DIR/scripts/publisher.mjs" publish --file <manifest.json>
node "$SKILL_DIR/scripts/publisher.mjs" reconcile --file <manifest.json>
```

默认状态位于 `~/.config/social-publish/<personId>/`，不在 Git 内；`SOCIAL_PUBLISH_STATE_ROOT` 可用于隔离测试。源码、文案和回执可复用，密钥、Cookie、浏览器档案不进仓库、不发到群里。

## 一条消息怎样处理

1. 读当前请求中明确要公开的内容和目标平台。默认保留原语言、事实、口吻，不补编经历、数字或结论。普通聊天不会触发发布。用户要草稿时只 prepare；收到“发”“发布”“同步到”等明确指令才将 `authorization` 设置为 `publish`。一次授权覆盖同一内容的改写、排版和指定平台发布，无需增加逐平台批准。
2. 用当前消息 ID／requestId 和 Session ID 填入 `source`；同一原请求重试继续使用同一 source，不能换 ID 绕过重复保护。按需从本轮 RemoteLab source-context 取得已核 personId 和消息引用。
3. 写 input JSON。X 可以用一段 `text`（prepare 自动分串）或自行编排 `thread`，每段保守按 280 加权字符校验，中文通常每字计 2。小红书标题不超过 20 字，正文与标签合计不超过 1000 字。超过限制时由你适配，保留影响意思的细节，不静默截断。只提供文字时，用 render-cards 自动排出文字配图；用户提供的图按其原意使用。排版脚本只生成文字卡，不编造照片。
4. 先 prepare 并检查正文、目标、时间、图片。没有账号时仍完成可用的 manifest 和配图，准备绑定入口，明确还未真实发布。不要把当前任务要求账号的部分拆成反复追问。
5. publish 先核对全部尚未发送平台的账号，再逐个平台发送并立刻落盘。成功的平台不会因另一平台失败而再次发。网络超时、崩溃或不明错误标为 `uncertain`，下次只回读；不能再次点击发布来探测结果。
6. reconcile 是只读核对。X 要读回 Buffer 中同一条 post 的 `sent` 和外链；小红书要在绑定账号个人列表里找到新笔记，并读详情核对作者、标题和正文。`submitted`、`scheduled`、`uncertain` 都不能说成已公开。需要等待平台处理时，用既有 RemoteLab Trigger 在明确期限内回读，不用前台 sleep，也不为每条消息创建常驻监控。
7. 回复逐平台结果与可访问链接；一个失败时说清原因和你已完成的部分。只有明确的输入拒绝可以在修正依据下使用 `publish --retry-rejected`；可在原授权内修正被拒绝平台的文案或图片，记录保留旧 manifest 和修改原因，不要求用户重新确认。已发送、已提交或结果未知的平台内容和目标不能更换，也不会重发。X 提交后没有取得 providerId 的异常保留 uncertain；当前版本不能自动恢复该外链，先检查 Buffer 的真实记录再处理，不假装已完成。

## 输入形状

```json
{
  "personId": "person_example",
  "source": {"sessionId": "session-id", "messageId": "original-message-id"},
  "authorization": "publish",
  "platforms": {
    "x": {"text": "要发布的文字"},
    "xiaohongshu": {"title": "标题", "content": "正文", "tags": [], "images": []}
  }
}
```

可选 `publishAt` 必须包含明确时区，且是未来时刻。小红书原生定时仅支持 1 小时到 14 天范围；不在范围内时用当前实例的 Trigger 到点执行，不偷换发布时间。X 原生定时交给 Buffer。排队成功与到时发布是两项结果。每个平台独立保存最终图片 SHA256，发布前检查图片没有被替换。

## 绑定与维护

读 [references/providers.md](references/providers.md) 获取选型、当前协议和不可自动完成的登录步骤。绑定入口是 scripts/binding-server.mjs：复用本实例密码认证，且只允许配置的当前 Person；只提供登录和选账号，不提供网页公开发布按钮。平台登录二维码、密钥通过受保护网页处理，密钥不放 URL。

小红书每人单独的后台服务、Cookie 路径和 bearer token。启动与检查先读官方工具当前 help，不连接其他任务正在使用的浏览器。持久登录降低日常工作量，但账号安全验证、撤销授权与 Cookie 过期仍可能需要本人重新绑定；不能承诺永久零人工。需要恢复绑定时保留发布回执，恢复后先回读，不重发未知记录。

知乎目前不支持真实发布：不在默认目标里，也不借用其他账号或临时猜写入接口。用户明确要知乎时说明未接入，先完成已授权的小红书和 X。该边界不妨碍以后接入已有授权的正式适配器。
