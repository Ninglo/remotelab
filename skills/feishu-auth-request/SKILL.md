---
name: feishu-auth-request
description: 飞书报 99991672、permission_violations 或用户要求办理权限时，区分 Bot scope、用户 OAuth 与资源 ACL；优先复用现有授权，用当前应用已有管理能力自助增量配置、提交和核验，确需人工时才交付最小申请。
---

# 飞书权限处理

先按 `lark-shared` 核对当前配置目录、profile、app ID、原操作的 Bot/User 身份及报错要求的精确 scope。资源 ACL 拒绝、用户 OAuth 和 Bot scope 分开诊断。

## Bot scope：先查现有自助能力

已授权任务需要的最小权限，在当前应用已有管理能力和租户规则允许时自行办理，完成后继续原任务。不要因 CLI 给出申请链接、一次 API 失败或旧摘要写着“需要管理员”，直接让用户重复开权限。

1. 使用同一 Bot profile 回读应用信息与实际租户授权：

   ```bash
   lark-cli --profile <name> api GET /open-apis/application/v6/applications/<app_id> --as bot --params '{"lang":"zh_cn"}'
   lark-cli --profile <name> api GET /open-apis/application/v6/scopes --as bot
   ```

   目标 scope 已有 `scope_type=tenant`、`grant_status=1` 时直接重试原操作。应用配置的 `token_types` 与租户生效状态分别检查。检查本应用是否已获 tenant `application:application:patch`；只有 `application:application:self_manage` 不足以证明能新增 scope。

2. 本应用已有配置权限时，通过官方 v7 开发配置接口只增加本次缺少的 tenant scope：

   ```bash
   lark-cli --profile <name> api PATCH /open-apis/application/v7/applications/<app_id>/config --as bot --data '{"scope":{"add_scopes":[{"scope_name":"<required_scope>","token_type":"tenant"}]}}'
   ```

   支持开发者后台创建的自建应用；Bot 只能操作自身。未传字段保持原样，不填写 `remove_scopes` 或顺带更改回调、事件、可见范围。应用正在审核时可能禁止修改，先读实际审核状态。

3. 回读 scope 状态。免审权限可能立即生效，不必为已生效权限制造一次发布。若仍需发布，先核对现有草稿、版本和全部待发布差异，再按当前官方 schema 调用 `POST /open-apis/application/v7/applications/<app_id>/publish`；保留原有端能力、版本约束，不把其他人的未发布修改一起提交。

   需要审核时，先检查已有的合法审批能力与获授权操作者。官方应用版本审核接口需要 `application:application.app_version` 及有效操作者身份；只有授权与能力均满足才可办理。没有这些条件时说明具体依赖，不能把“能修改应用”推断为“有权批准”，不能冒充管理员或为绕过审批新增管理权限。

4. 核验目标 tenant scope 的 `grant_status=1`，再执行原业务并回读结果。配置成功、提交成功、审核通过和业务成功分别记录，不能互相代替。写入结果不确定先回读，避免重复操作。

`POST /open-apis/application/v6/scopes/apply` 只申请应用**已配置、租户尚未授权**的权限，不能新增未配置 scope。先查询确有目标待授权才调用；返回 `212002 unauthorized scopes were empty` 后不要重复空申请，应查配置入口及实际状态。

## 确需人介入的兜底

缺少可用管理授权、租户明确要求人工审核、必须本人登录，或新增影响超出原任务授权时，指出已尝试的路径、准确缺口和最小人工动作。Bot scope 需要所有者办理时，提供仅含缺少权限的专用页：

```text
https://open.feishu.cn/page/scope-apply?clientID=<app_id>&scopes=<URL-encoded,comma-separated-scopes>
```

多个 scope 用英文逗号连接后整体编码。旧 CLI `/app/<app_id>/auth` 是后台入口，不能替代专用申请页。用户完成后继续回读授权和原任务，不把打开页面当成批准。

## 用户 OAuth 与资源访问

原操作本来应使用用户身份时，先复用合适的现有授权，查 `auth status --json --verify` 和 `auth check`；确实缺 scope 再按 `auth login --help` 发起最小增量授权，由本人完成必要同意。用户 OAuth 不会补齐 Bot scope，不能悄悄换个人 token 绕过 Bot 报错。

资源 ACL、妙记数据范围、群成员或管理员要求，按对应领域 Skill 处理；新增 scope 不会自动授予具体资源权限。

## 验证记录与查证入口

2026-10-12，已在一个自建 Bot 上验证：已有 tenant `application:application:patch`，经 v7 config 增量加入 `im:chat.announcement:read`、`im:chat.announcement:write_only`，两项均立即 `grant_status=1`，随后新版群公告读写及内容回读成功。该案例无需另行审批，不证明所有 scope 免审，也不证明当前实例具备所有版本审批能力；每次仍查现场状态。

- [官方开发配置接口](https://open.feishu.cn/api-explorer?from=op_doc_tab&apiName=patch&project=application&resource=application.config&version=v7)
- [官方提交发布接口](https://open.feishu.cn/api-explorer?from=op_doc_tab&apiName=create&project=application&resource=application.publish&version=v7)
- [官方 SDK 请求字段与接口约束](https://github.com/larksuite/oapi-sdk-go/tree/v3_main/service/application/v7)

只使用当前获授权的应用与身份，不输出 token 或 secret。权限办理后继续原业务验收；涉及回调或卡片时，还需核对配置并测试新发卡片，不能用旧卡片代替。
