# Guest Port Expose

Use for 网页预览, 静态网页, demo 链接, 公开端口, 反向代理, 长期运行服务, or whenever a guest instance needs a stable public URL for an app running on an extra local port.

## Goal

Publish one guest-owned loopback service through a controlled hostname without editing Cloudflare tunnel files directly.

## Command

```bash
remotelab guest-instance expose <instance> --label <label> --port <port>
```

Example:

```bash
remotelab guest-instance expose trial24 --label report --port 3000
```

This creates a hostname shaped like:

```text
trial24-report.<instance-domain>
```

## Safety rules

- The instance must already be an isolated guest instance.
- The target port must already be listening.
- The listener must be loopback-only (`127.0.0.1` or `::1`), not `0.0.0.0`.
- The listener must belong to the same guest instance user.
- The hostname is derived from the instance hostname plus `-<label>`; arbitrary hostnames are not allowed.
- Keep the origin under systemd or an equivalent restart-safe supervisor and enable it before treating the URL as delivered.
- Do not fall back to a Quick Tunnel. `trycloudflare.com` is permitted only for a user-requested one-off isolated experiment and is never a formal delivery URL.

## Removal

```bash
remotelab guest-instance unexpose <instance> --label <label>
```

## Notes

- This writes to the controlled guest-route registry consumed by the host router.
- It does not edit `cloudflared` ingress directly.
- Re-running the same command is idempotent.
