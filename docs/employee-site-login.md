# Employee website login

Give the agent: “Use the current instance's shared employee login for this new
website. The human who creates it is responsible, every company employee can
access it, and administrator positions remain reserved. Reuse existing login
state and implement only login.” Provide the source directory or a healthy
loopback service and its stable slug. The accepted human Request supplies the
creator; a manual or unattended publication supplies `--owner <person-id>`.

[项目总站](/sites) 自动汇总当前实例的静态发布和动态入口，并支持外部网站登记、维护信息补充与迁移清单导出；沿用同一员工登录。详见 [总站登记与迁移清单](site-directory.md)。

## 当前使用飞书员工登录

[点击体验首次登录与站点切换](/public-pages/remotelab-architecture-atlas/employee-login-demo.html)。
演示位于现有整体说明网站，只切换模拟画面，不接触真实登录态。
页面与两个真实示例站均按当前飞书设备授权流程说明；公司 SSO 接入已暂停。

实际访问顺序是：打开目标网站 → 未登录则跳到 `/site-login?returnTo=原网址` →
点击“使用飞书登录”，在新标签页完成飞书身份确认 → 回到原标签页，它检测到成功后自动进入原网站。
飞书页不负责跳到各个业务网站；原登录页按飞书给定间隔查询授权结果，再按 `returnTo` 继续。
已有有效身份时直接进入，正常切站无需再打开飞书。

RemoteLab 控制台在原 `/login` 卡片中提供飞书按钮，直接打开飞书确认页；确认后
在原卡片完成账号映射并进入最初请求的页面，不再经过另一张员工登录页。返回原标签页
会立即检查结果，服务端仍遵守飞书轮询间隔。被浏览器拦截新窗口时，可点击卡片中的
“打开飞书确认”。失败或无控制台资格时在卡片内显示原因，保留已输入的原账号和 Token 登录。
扫码成功后只映射同一个 Person 的现有个人凭据和 Web 身份；不会给其他员工新增控制台权限。
主动退出后仍停留在登录页，重新点击飞书按钮才复用已有员工身份。

`POST /api/auth/feishu/complete` 接受同源 JSON `{next}`，持久化原账号会话后才签发
控制台 Cookie，并返回同源目标。已有控制台会话优先，不切换人员。旧 `/login/feishu`
回调继续兼容；员工网站的 `/site-login` 流程保持原入口。

浏览器回归入口为 `tests/test-workbench-login-browser.mjs`，通过
`EMPLOYEE_TEST_PLAYWRIGHT` 和 `EMPLOYEE_TEST_CHROME` 指定已有 Playwright 模块与 Chromium。
测试使用隔离身份与飞书响应夹具，覆盖首次确认直达目标、已核身份复用、退出暂停、
弹窗拦截、内联拒绝，以及桌面／手机和浅色／深色布局。

| 现有组件 | 承担的工作 |
| --- | --- |
| 域名的 HTTPS／反向代理入口 | 将静态网站、动态网站与登录请求送到同一 RemoteLab 服务 |
| 静态发布 `/public-pages/<slug>/` | 发布时登记员工访问和负责人；服务端检查登录后才返回 HTML、数据与图片 |
| 动态预览 `/preview/<slug>/` | 检查登录后代理到本机服务，并向服务传递已核人员身份 |
| 统一员工登录 `/site-login` | 调用飞书设备授权接口，核对公司标识，签发同域共享会话 |
| 浏览器与服务端会话存储 | 浏览器保存 HttpOnly Cookie；服务端持久化会话，避免每次访问都调用飞书 |

新建网站复用静态发布器或动态预览入口即可接入。负责人取创建人的已核身份，公司员工均可访问；
管理员字段预留，不增加角色管理。独立域名、其他浏览器或浏览器内置 WebView 不共享同一份 Cookie。
当前实现不要求先到网站门户挑选站点，也没有替旧站自动移除原有密码。

## Configuration and scope

For the existing device provider, `site-login.json` in the instance config directory contains `realm`, `tenantKey`,
`feishuConfigPath`, and optional `personIds` for already verified employees who
also have a RemoteLab login. The application credentials remain in the existing
private file, not source code. Existing research deployments can reuse
`qianyan-internal.json` without copying credentials. No new Feishu scopes or
redirect domain are required for the existing device authorization flow.

Configured instances default new `publish static` and `preview expose` sites to
`employee`. Static publishing can explicitly select `--access public`; previews
can select `--access basic`. Replacements preserve existing access and owner.
Unconfigured instances retain legacy defaults. Invalid configuration is an
error, not a reason to publish an employee site publicly.

The publication records `ownerPersonId` from the accepted input's verified Person
and `adminPersonIds: []`. These fields record responsibility and reserve future
administrators; they do not add permissions, role workflows or control-plane access.
There is no project restriction: an identity returned by the configured Feishu
application with the configured company `tenant_key` is accepted.

## One login across managed sites

An anonymous navigation opens `/site-login`, then returns to the requested site.
The page checks existing login first. The first visitor opens the Feishu identity
confirmation; the page observes completion at the provider's interval and stops
at its deadline. Refreshing an existing attempt reuses its pending authorization.
No website password is issued.

A valid RemoteLab browser session with an exact Feishu identity in the configured
realm is already verified, receives a shared employee cookie, and enters websites without another Feishu
confirmation. Explicit `personIds` remain supported. A service credential does
not establish a human browser identity. A stale shared cookie does not hide a
valid legacy research cookie; the latter upgrades without reauthorization.

`employee_site_session` is host-only, HttpOnly, SameSite=Lax, Secure on HTTPS and
scoped to `/`. Static pages, previews and research internal APIs share it on the
same instance domain. The existing `qianyan-identity.json` durable store is reused.
Old path-scoped research cookies upgrade through the existing research identity
endpoint without another Feishu prompt. Valid sessions renew to 30 days at most
once per day; normal requests and renewal do not call Feishu. Restarting the
service preserves sessions. Logout removes the server-side session.

This is same-domain reuse, not cross-domain SSO. A different browser, browser
profile or independent domain has a different cookie context. No broad parent-
domain cookie is issued. Independently hosted sites require their own ingress integration.
Existing Basic Auth sites use the explicit migration below. Employee status synchronization and
offboarding remain outside this login-only scope.

## Authentication boundary

The server checks employee static publication metadata before resolving **any**
asset. Responses use `private, no-store`. Only the managed `/public-pages` ingress
can publish employee pages; an alternate static server over the same directory
would bypass this protection and must not be configured. Public pages retain
their original public contract. Published MP4/WebM/MOV/M4V use video MIME types and
the existing byte-range response for seeking. Employee authorization runs before
full or partial media responses; private cache and Cookie variation apply to both.

Employee previews authenticate before proxying. Their upstream has no second
login, listens only on loopback, and receives `x-remotelab-person-id` generated by
the proxy. Browser cookies, bearer tokens and forged identity headers are not
forwarded. The existing allowed-method and exact POST-path registration remain;
employee POSTs additionally require the same origin. Application input validation
and business behavior stay with the application.

The employee cookie does not directly authenticate control-plane APIs. The
RemoteLab login page completes Feishu authorization in its original card via
`POST /api/auth/feishu/complete`; `/login/feishu?next=...` remains a compatible
callback. An existing valid workbench session continues unchanged; otherwise, a verified employee maps to the exact
existing Person only if that Person currently has a personal password or token
credential and Web identity. The bridge persists an ordinary workbench session
before redirecting. New employees with no workbench credential are not admitted.
The original password and Token forms remain usable when the optional bridge is
unavailable. Existing requests, Sessions and credentials are not rewritten.
An explicit workbench logout pauses automatic re-entry in that browser. The
login form remains visible until the person chooses Feishu or successfully uses
the original credential again. Employee website sessions are retained, so signing
out of the console does not interrupt other websites.

## Existing websites: Feishu entry without a first password login

Ask the agent to migrate the existing website's entry to Feishu, preserve its
original people/roles and direct authenticated callers, and verify the first
employee visit without supplying any website password. Use
`preview migrate-login --slug <existing-name> --credential-file <private-json>`.
The private JSON contains an upstream `authorization` and either `employees: true`
for an authorized shared employee site or `personIds` for its original private
users. Verify scope from the existing application; an employee identity does not
grant access to another person's account-binding service or a control console.

The gateway checks employee identity, selects the site's scoped credential and
forwards it only to the registered loopback port. Anonymous HTML goes to Feishu;
an already verified browser enters directly on its first visit. A private site's
other employees receive 403 without a password dialog. Original callers that
send their own Authorization continue through the original verifier. Registered
write paths, application roles, video ranges, owners and data remain unchanged.
If the upstream credential expires, return a mapping error without presenting
another password login. The migration keeps the original route intact and pins
the overlay and credential to the same port.

For an upstream with only a password hash, `lib/preview-upstream-auth.mjs` is a
small optional server adapter. Keep its original verifier, and also accept a
separate random `Bearer` capability marked `upstreamToken: true` in the private
binding. The adapter checks the capability against its own local port; the ingress
owns employee/person admission. This key is independent of user credentials and
is never placed in HTML, telemetry or the site directory. Applications with
different roles must map to the original role or a read-only role, never choose
an administrator implicitly. Keep the application loopback-only.

`tests/test-site-login-migration.mjs` covers first-visit entry, private/shared
scope, original calls, forged identity, cross-origin writes, video seek, expired
mapping and the port-scoped upstream adapter. A new employee publication checks
the actual GET entry: a second Basic challenge, login redirect or password form
rejects publication. Configured instances reject new `--access basic` routes.

### Optional credential caching for sites not yet migrated

Credential caching is not a completed Feishu migration. For a site intentionally
retaining its first password login, enable compatible identity reuse for existing Basic
websites, preserve the original URLs and allowed operations, and verify both the
old login and the exact person's reused login. Use `preview reuse-identity --slug
<existing-slug>` only after the original root still returns a Basic challenge.
It records `reuseIdentity: true` in private `site-identity-policies.json`, pinned to the current upstream port; it leaves the original route file untouched, including the port, owner, access mode, registered
POST paths and forwarded-header list. It does not restart the application.

The old Basic request continues unchanged. When a browser also has a verified
employee identity and its original Basic login succeeds at the site's root, the
proxy saves that site's accepted credential for that Person. Later requests from
that verified Person can reuse it; a different employee gets no grant. The
upstream still validates the credential on every request, so changing or revoking
the original credential takes effect. Explicit browser credentials take precedence.
Replayed authenticated writes require the same origin; original authenticated
requests retain their existing CSRF contract. Failed optional mapping storage
does not interrupt the old access path. Sharing a password alone never identifies
one employee, and anonymous historical visits are not attributed retrospectively.

`site-legacy-logins.json` is a private credential store (0600), outside Git. It
contains reusable Basic authorization and must remain with private instance
backup/credential handling; never include it in site-directory exports, telemetry
or public artifacts. Disable reuse by removing that site from `site-identity-policies.json`; original
Basic authentication remains in effect. Replacing the upstream port does not
inherit the old policy or credential mapping.

For an intentionally public existing application, `preview recognize-identity
--slug <existing-slug>` adds optional verified attribution without requiring login
or changing its original access. Anonymous and in-flight calls continue. Closing
public access requires a separate access-policy change; do not infer it from a
legacy `basic` metadata label. No automatic company-SSO switch is performed.

## Verification and rollout

Run `node scripts/run-with-clean-instance-env.mjs node tests/test-employee-site-login.mjs`.
`tests/test-workbench-site-login.mjs` covers existing-session precedence, the
exact original account, durable exchange, admission and failure compatibility;
`tests/test-legacy-site-login.mjs` covers preserved Basic calls and writes,
per-person reuse, forgery, revocation and private persistence.
Optional `EMPLOYEE_TEST_PLAYWRIGHT` (module path) and `EMPLOYEE_TEST_CHROME`
(executable path) exercise the actual login page at desktop/mobile sizes against
an isolated provider fixture. The fixture is not a real employee authorization.
Existing research, static publication and preview regression suites also apply.

Feishu device polling returns HTTP 400 with both `error: authorization_pending`
and numeric `code: 20094` while the person is confirming. This is a normal waiting
state, not an unavailable service. Preserve the attempt and provider polling
interval, then continue through token exchange, company validation and cookie
issuance. Regression fixtures include this real response shape; live verification
must observe provider polling, not stop when the authorization link appears.

Verify the deployed anonymous boundary and actual Feishu authorization start.
Employee content still needs an authenticated content read; the publisher's
anonymous rejection result alone does not certify it. Keep existing URLs, owner
records and credentials when migrating a selected old site. Revert a migrated
route using its retained prior policy; do not make it public as a login fallback.

## Optional company SSO adapter (not active)

Company SSO rollout is paused by the requester on 2026-10-30. The current deployment continues to use the original Feishu employee login. The retained website adapter supports the existing Muka Envoy authentication contract.
This is application-side support, not an automatically registered production SSO
client. Production activation requires the SSO operator to register an independent
website client, grant its entry permission to employees, and connect the gateway.
Do not switch an instance's provider until that ingress works. A change to
`site-login.json` alone cannot connect a website to company SSO.

The intended experience is: open the target website → company SSO → return to that
website. An existing Hub/Data root session is reused by the company issuer; when
it is valid, entering a new application does not require another Feishu login.
Each application retains its own host-only cookies. No site directory or password
creation is required. Within the hosted-sites application, A and B share the same
gateway login. Browser/WebView cookie isolation still applies.

Give the deploying agent one packet: the registered issuer and app ID, website
origin, entry permission, gateway/backend connection, private source-key file,
and the SSO operator's registration/deployment entry. Reuse the company's existing
Envoy OAuth implementation, including PKCE, root-session validation, token refresh
and logout. Do not reconstruct these mechanisms inside each website.

```json
{
  "provider": "muka-sso-gateway",
  "issuer": "https://auth.example.test",
  "appId": "remotelab-sites",
  "publicOrigin": "https://sites.example.test",
  "entryPermission": "app.remotelab-sites.access",
  "sourceKeyFile": "/private/instance/site-sso-source.key"
}
```

Keep `sourceKeyFile` private (0600) and outside Git. It contains the independent
gateway-to-application source key, not a Hydra client secret or the Permission
Center internal key. The gateway must remove caller-supplied `x-muka-*` identity
headers and then insert the verified `x-muka-user-id`, `x-muka-platform-role`,
`x-muka-permissions`, base64url JSON `x-muka-user-profile`, and `x-muka-source-key`.
It must preserve the exact registered HTTPS origin in Host/forwarded headers.
The adapter validates the source key, origin, entry permission and profile ID
before registering an issuer/subject identity. A matching name/email never links
an unrelated existing Person automatically. New identities have no workbench credential.

The gateway must authenticate every employee HTML/data/asset request, `/preview`
request and `/api/site-login/*` request, and handle `/oauth2/callback` and
`/oauth2/signout` itself. `/site-login?returnTo=...` returns an authenticated user
to a same-origin target. An unconnected gateway returns 503 there, not an endless
login redirect. Existing public and Basic Auth routes must keep their policies;
the gateway cannot simply put the entire mixed workbench domain behind employee
SSO. A dedicated website ingress or a gateway route integration is a deployment
prerequisite. Future websites need to inherit that ingress automatically, without
a separate OAuth client or a manual route change for every publication.

SSO mode does not accept old employee cookies or workbench login as a fallback,
does not cache employee authorization locally, and does not create a second
30-day session. Root expiry, offboarding and revocation remain the company's
responsibility at the gateway. `POST /api/site-login/logout` returns
`state: redirect` and `redirect_url`; the caller must navigate to it to complete
company logout. Returning that URL alone does not mean the user has logged out.
The separate research API retains its previous identity configuration during
this hosted-site migration.

Control-console SSO is a later integration. The identity adapter can be reused,
but employee website access and even `platform_admin` do not grant workbench
access. Website creator and reserved administrator records remain unchanged.

Run `node scripts/run-with-clean-instance-env.mjs node tests/test-employee-site-gateway.mjs`
for the gateway contract fixtures and the existing employee-login regression.
Production acceptance still requires a real company login, Hub → website and
A → B reuse, direct-origin/header-forgery rejection, logout/expiry, restart, and
public/control-console policy preservation. Local fixtures do not establish that
the production gateway or employee grant exists.
