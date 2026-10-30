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
See [employee site login](../employee-site-login.md).

Existing Basic Auth routes retain their authentication on replacement. Instances
without employee identity configuration retain the Basic Auth default; explicitly
select it with `--access basic`. The command checks its upstream Basic challenge.
Switching a known route to `--access employee` requires removing the redundant
upstream login; no passwords are automatically migrated or deleted.

For a gradual migration that preserves existing Basic logins and registered
operations, use `preview reuse-identity --slug <existing-name>`. The upstream must
still challenge anonymous root access. Only a verified employee who also
successfully uses the original site's Basic login receives a reusable mapping;
other employees gain no access. `preview recognize-identity --slug <existing-name>`
adds optional attribution to an intentionally public upstream without gating it.
Both commands preserve the existing route fields. See the employee-login guide
for the private credential store, scope and rollback.

Both modes use `<instance-domain>/preview/<name>/` and the existing domain/tunnel.
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
