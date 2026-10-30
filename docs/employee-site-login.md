# Employee website login

Give the agent: “Use the current instance's shared employee login for this new
website. The human who creates it is responsible, every company employee can
access it, and administrator positions remain reserved. Reuse existing login
state and implement only login.” Provide the source directory or a healthy
loopback service and its stable slug. The accepted human Request supplies the
creator; a manual or unattended publication supplies `--owner <person-id>`.

## Company SSO gateway integration

The website adapter supports the existing Muka Envoy authentication contract.
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

## Existing Feishu device login

[点击体验首次登录与站点切换](/public-pages/remotelab-architecture-atlas/employee-login-demo.html)。
演示位于现有整体说明网站，只切换模拟画面，不接触真实登录态。
页面分别标注公司 SSO 目标流程与两个真实示例站当前仍使用的设备授权。

实际访问顺序是：打开目标网站 → 未登录则跳到 `/site-login?returnTo=原网址` →
点击“使用飞书登录”，在新标签页完成飞书身份确认 → 回到原标签页，它检测到成功后自动进入原网站。
飞书页不负责跳到各个业务网站；原登录页按飞书给定间隔查询授权结果，再按 `returnTo` 继续。
已有有效身份时直接进入，正常切站无需再打开飞书。

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

`employee_site_session` is host-only, HttpOnly, SameSite=Lax, Secure on HTTPS and
scoped to `/`. Static pages, previews and research internal APIs share it on the
same instance domain. The existing `qianyan-identity.json` durable store is reused.
Old path-scoped research cookies upgrade through the existing research identity
endpoint without another Feishu prompt. Valid sessions renew to 30 days at most
once per day; normal requests and renewal do not call Feishu. Restarting the
service preserves sessions. Logout removes the server-side session.

This is same-domain reuse, not cross-domain SSO. A different browser, browser
profile or independent domain has a different cookie context. No broad parent-
domain cookie is issued. Existing independently hosted sites and Basic Auth
passwords are not automatically migrated. Employee status synchronization and
offboarding remain outside this login-only scope.

## Authentication boundary

The server checks employee static publication metadata before resolving **any**
asset. Responses use `private, no-store`. Only the managed `/public-pages` ingress
can publish employee pages; an alternate static server over the same directory
would bypass this protection and must not be configured. Public pages retain
their original public contract.

Employee previews authenticate before proxying. Their upstream has no second
login, listens only on loopback, and receives `x-remotelab-person-id` generated by
the proxy. Browser cookies, bearer tokens and forged identity headers are not
forwarded. The existing allowed-method and exact POST-path registration remain;
employee POSTs additionally require the same origin. Application input validation
and business behavior stay with the application.

The employee cookie never authenticates the RemoteLab workbench. New verified
employees receive a Person identity with no control-plane credential. A service
token is not accepted as an employee browser login.

## Verification and rollout

Run `node scripts/run-with-clean-instance-env.mjs node tests/test-employee-site-login.mjs`.
Optional `EMPLOYEE_TEST_PLAYWRIGHT` (module path) and `EMPLOYEE_TEST_CHROME`
(executable path) exercise the actual login page at desktop/mobile sizes against
an isolated provider fixture. The fixture is not a real employee authorization.
Existing research, static publication and preview regression suites also apply.

Verify the deployed anonymous boundary and actual Feishu authorization start.
Employee content still needs an authenticated content read; the publisher's
anonymous rejection result alone does not certify it. Keep existing URLs, owner
records and credentials when migrating a selected old site. Revert a migrated
route using its retained prior policy; do not make it public as a login fallback.
