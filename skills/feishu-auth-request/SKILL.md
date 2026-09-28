---
name: feishu-auth-request
description: 飞书调用缺权限时，区分 Bot 应用权限、用户 OAuth 和资源访问权限；为缺少的 Bot scope 生成单独的权限申请页。适用于 99991672、permission_violations 或用户要求申请应用权限。
---

# 飞书权限申请

先按 `lark-shared` 选已有的 `lark-cli` profile，核对 app ID、原操作应使用 Bot 还是用户身份、实际报错要求的精确 scope。资源本身拒绝访问（ACL）时，不能当作缺 scope。

## 缺 Bot 应用权限

把仅包含所需 scope 的飞书专用申请页发给应用所有者或管理员：

```text
https://open.feishu.cn/page/scope-apply?clientID=<app_id>&scopes=<URL-encoded,comma-separated-scopes>
```

例如，要为应用 `cli_xxx` 申请 `application:application:patch`：

```text
https://open.feishu.cn/page/scope-apply?clientID=cli_xxx&scopes=application%3Aapplication%3Apatch
```

多个 scope 用英文逗号连接后整体做 URL 编码。这个页面让所有者确认新增应用权限，并处理相应版本提交；需审核的权限仍要等审核。直接在当前对话发链接，不换成开发者后台扫码登录或用户 OAuth 链接。若页面提示 scope 不支持、身份不符或申请失败，以页面实际结果为准。

旧版 CLI 若给出 `/app/<app_id>/auth`，那是开发者后台入口，不能替代上述 Bot 权限申请页。

所有者确认后，用同一 Bot profile 读回应用配置和租户授权状态：

```bash
lark-cli --profile <name> api GET /open-apis/application/v6/applications/<app_id> --as bot --params '{"lang":"zh_cn"}'
lark-cli --profile <name> api GET /open-apis/application/v6/scopes --as bot
```

确认目标 scope 的 `token_types` 包含 `tenant`，且租户的 `grant_status=1`，再重试原 Bot 操作。新增 scope、提交版本、审核通过、业务成功是四件事，不互相代替。

`POST /open-apis/application/v6/scopes/apply` 是另一种接口，只能申请应用已配置、租户尚未授权的权限。先用 `GET /open-apis/application/v6/scopes` 查到本次目标确实待授权时才调用。返回 `212002 unauthorized scopes were empty` 不妨碍用专用页面新增 Bot scope；不要反复提交空申请。

## 缺用户 OAuth 权限

仅当原操作本来就应以用户身份执行时，先查 `auth status --json --verify` 和 `auth check`。确实缺用户 scope，再按当前 CLI 的 `auth login --help` 发起最小范围的 `auth login --scope <scope> --no-wait --json`，交付验证链接，用户同意后完成同一次授权。用户 OAuth 不会补齐 Bot scope；不能为了绕过 Bot 权限报错悄悄切换到个人 token。

## 回到原任务验收

权限生效不等于回调已配置、事件已订阅或功能已成功。继续完成原操作和必要的独立版本变更，再核验实际结果。`card.action.trigger` 要回读回调配置，并用新发的卡片测试；旧卡片不能用于验收。

只用当前应用获授权的 profile，不输出 token 或 app secret，不扩大到其他应用，不把“链接已打开”说成“权限已批准”。
