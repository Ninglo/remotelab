# Service Port Forwarding

Use for a dynamic or stateful service that is already listening on a local loopback port and needs a stable public URL alongside RemoteLab.

This is ingress guidance, not static-file deployment. For a directory of HTML/CSS/JS files, use Static Page Publish instead.

## Reuse the RemoteLab ingress shape

A normal RemoteLab deployment already maps a stable hostname through Cloudflare Tunnel or another reverse proxy to a loopback-only service. Additional services should follow the same pattern:

1. keep the application bound to `127.0.0.1` or `::1`;
2. run it under systemd, launchd, or another restart-safe supervisor;
3. assign a stable sibling hostname derived from the RemoteLab instance/domain;
4. add one managed ingress route from that hostname to the service port;
5. verify the public URL after the local service and ingress are both healthy.

Keep the application on loopback and verify the configured public route reaches the intended service.

## Managed guest command

For a preview on an instance with employee login configured, use
`remotelab preview expose --slug <name> --port <port> --json`. New routes default
to company employees, record the current human creator as owner, and reserve
`adminPersonIds: []`. Use `--owner <person-id>` outside a human Request.
The loopback application must be healthy without its own login: the proxy handles
login once and forwards the verified `x-remotelab-person-id`, never the employee
cookie or a client-supplied identity header. Keep the application loopback-only.
See [employee site login](../employee-site-login.md). When `sso.issuerOrigin` is
configured, new employee previews reuse the same cross-domain login automatically.
For an independent hostname, route its complete ingress to this instance and register
it in `employee-site-hosts.json`; this registration also enrolls it in SSO. Do not
proxy internal HTML straight to an unauthenticated backend or add a second login.

Existing Basic Auth routes retain their authentication on replacement. Instances
without employee identity configuration retain the Basic Auth default; explicitly
select it with `--access basic`. Configured instances reject Basic for new internal
routes. Employee publication checks the actual GET page for another challenge,
login redirect or password form, rather than relying on a HEAD health check.
Switching a known route to `--access employee` requires removing the redundant
upstream login; no passwords are automatically migrated or deleted.

For a gradual migration that preserves existing Basic logins and registered
operations while removing the first password prompt, use
`preview migrate-login --slug <existing-name> --credential-file <private-json>`.
The private file supplies the upstream credential and the original employee/person
scope; the gateway checks Feishu and reuses that scoped credential on the first visit.
Hash-only servers can retain their verifier and add the port-scoped upstream adapter.
See the employee-login guide for scope, roles, validation and private credential handling.

`preview reuse-identity --slug <existing-name>` only caches an original successful
password login and does not complete this migration. The upstream must
still challenge anonymous root access. Only a verified employee who also
successfully uses the original site's Basic login receives a reusable mapping;
other employees gain no access. `preview recognize-identity --slug <existing-name>`
adds optional attribution to an intentionally public upstream without gating it.
Both commands store a private identity policy pinned to the original upstream port, leaving the existing route file untouched. See the employee-login guide
for the private credential store, scope and rollback.

Both modes use `<instance-domain>/preview/<name>/` and the existing domain/tunnel.

### One-use invitations for selected employee previews

Ask the agent: “Enable guest invitations for this one managed preview. Confirm the live URL, existing owner, and the ordinary in-app operations that guests will inherit. Leave employees, other sites and business roles unchanged. Do not create or send invitations; the site owner will do that.” Give the exact preview URL and the access scope. Use this only for an upstream where the same ordinary operations and shared data are approved for guests. Existing per-person ownership checks still apply; even upload, device pairing or automatic queues may be part of the ordinary workflow.

For this instance add the selected slug in private `preview-guest-invites.json` (mode 0600), preserving other entries:

```json
{"my-preview":{"port":18746,"ownerPersonId":"person_example","origin":"https://example.test","title":"Example site"}}
```

The entry works only on the exact HTTPS origin and while the original employee preview matches the slug, port and owner. It does not change the route or the employee login. The verified preview owner finds **访客邀请** in `/sites` on that origin, or opens `/preview/<slug>/_invite/manage`. The owner issues a distinct link per recipient and sends it privately; anyone who receives the unredeemed link can claim it. Only an explicit click spends it, within 24 hours; normal link previews do not. The invitation code appears only in the URL fragment and in the redemption body, not in the access URL or list. Do not log redemption bodies. After confirmation the grant does not expire automatically, and a scoped cookie keeps that browser signed in on future visits; clearing cookies, browser retention limits, or switching browsers can require a new invitation. A guest gets a distinct preview-only actor, not a workbench, directory, or employee identity. Revoke either a pending link or the resulting grant from the same screen. Revocation blocks new website requests; it does not undo completed actions or cancel jobs already queued by the upstream.

Verify with `node scripts/run-with-clean-instance-env.mjs node tests/test-preview-guests.mjs` (optionally set `SITE_TEST_PLAYWRIGHT` and `SITE_TEST_CHROME` for browser coverage). Production verification should check owner login redirection, the explicit accept page, and rejection of ordinary anonymous requests. Use isolated data for issuance, expiry, competing redemption, guest writes, route isolation and revocation tests; do not test by initiating production device work. The instance-local `preview-guest-grants.json.sqlite` stores hashed credentials and grant history. Inactive rows are pruned on issuance after 90 days. To disable the feature immediately without changing employee access, remove only the slug's opt-in record; restoring an unchanged record restores unrevoked guests. Keep the SQLite state in private backups rather than deleting it or exporting links.

Keep the service under a restart-safe supervisor. Remove it with
`remotelab preview unexpose --slug <name>`.

Preview routes allow GET and HEAD by default. Byte-range requests and response
headers are preserved so video playback can seek without downloading the whole
file. For an application that saves user input, register each exact POST path
and any required custom request header explicitly:

```bash
remotelab preview expose --slug review --port 18746 --replace \
  --post-path /api/review --forward-header x-review-action --json
```

Both options can be repeated. POST is enabled only at the registered paths;
other paths and existing routes remain read-only. For employee routes, the proxy authenticates and rejects cross-origin POSTs.
The application still owns input validation and business operations. Basic routes
retain application-owned authentication and CSRF protection. Standard authorization,
content metadata, origin and range headers are forwarded; RemoteLab cookies
are not. Custom headers must be lowercase `x-` application headers, excluding
proxy address headers. Replacement supplies the complete route configuration;
omitting these options resets the route to read-only.

Verify through the public URL, including an unauthenticated request, a real
video seek and a save against isolated test data. Local playback or local POST
success alone does not verify the ingress path.

Guest instances can instead assign a sibling hostname through the managed
guest command below.

For an isolated RemoteLab guest instance, use the built-in controlled route command:

```bash
remotelab guest-instance expose <instance> --label <label> --port <port>
```

Example:

```bash
remotelab guest-instance expose trial24 --label report --port 3000
```

The hostname is derived from the instance hostname and label, such as:

```text
trial24-report.<instance-domain>
```

Remove it with:

```bash
remotelab guest-instance unexpose <instance> --label <label>
```

## Safety rules

- The target port must already be listening.
- The listener must belong to the same guest instance user.
- The listener must be loopback-only.
- Arbitrary hostnames are not accepted by the managed guest command.
- Keep dynamic service forwarding separate from RemoteLab's static page storage.
