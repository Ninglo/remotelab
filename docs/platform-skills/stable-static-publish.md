# Static Page Publish

Use for static HTML reports, review pages, dashboards, demos, or any other directory that can be served as files without a running application process.

## Product boundary

RemoteLab owns the static file server and publish lifecycle. Public ingress is separate:

- publishing copies files into the current instance's managed local data directory;
- published files never live in the RemoteLab Git checkout;
- the existing RemoteLab domain, Cloudflare Tunnel, or another configured reverse proxy makes the route externally reachable;
- an ordinary publish does not call Cloudflare, Wrangler, or any provider API.

Use Service Port Forwarding instead when the result needs a long-running process, API, database connection, WebSocket, or server-side state.

## Publish

```bash
remotelab publish static --source ./dist --slug my-report --json
```

The source may be one HTML file or a directory containing `index.html`. Use `--replace` only when intentionally updating the same stable slug.

Management commands:

```bash
remotelab publish list --json
remotelab publish delete my-report --json
```

## Storage and delivery contract

- Default storage is the instance-local `public-pages` directory under RemoteLab's configured data root.
- Override the storage location with `REMOTELAB_PUBLIC_PAGES_DIR` when the host needs a dedicated volume.
- Override the external URL base with `REMOTELAB_PUBLIC_PAGES_BASE_URL` when ingress does not use the main RemoteLab domain.
- The command returns a public URL when public ingress is configured and a loopback URL otherwise.
- Verify that the returned URL resolves directly to the intended page; a redirect to login is not successful delivery.

## Safety

- Run an automatic recursive secret/private-data scan and publish when the output is clean, scoped, and reversible. Do not wait for optional human review. Pause only when unresolved personal data, credentials, raw contact lists, tokenized URLs, or material legal/brand risk remains, and make that blocker visible with a recovery path.
- The publisher skips hidden files, VCS data, `node_modules`, caches, and symbolic links.
- Prefer a new slug for important snapshots. Use `--allow-large` only after inspecting the source tree.
