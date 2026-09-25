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

For a preview on the current RemoteLab instance with its own HTTP Basic login,
use `remotelab preview expose --slug <name> --port <port> --json`. It checks that
the loopback service challenges unauthenticated requests, then serves it at
`<instance-domain>/preview/<name>/`. This reuses the instance's existing
domain and tunnel. Keep the service under a restart-safe supervisor. Use
`remotelab preview unexpose --slug <name>` to remove the route.

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
