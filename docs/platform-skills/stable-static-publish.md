# Static Page Publish

Use for static HTML reports, review pages, dashboards, demos, or any other directory that can be served as files without a running application process.

Give the agent: “Publish this site using the instance's employee login. Make the current
human creator its owner, allow all company employees, and reserve the administrator
field without adding role management.” Supply the source directory and stable slug.
The agent resolves the accepted Request's creator; outside a human Request, supply
`--owner <person-id>`. No per-site account or password is generated.

## Product boundary

RemoteLab owns the static file server and publish lifecycle. Public ingress is separate:

- publishing copies files into the current instance's managed local data directory;
- published files never live in the RemoteLab Git checkout;
- the existing RemoteLab domain, Cloudflare Tunnel, or another configured reverse proxy makes the route externally reachable;
- an ordinary publish does not call Cloudflare, Wrangler, or any provider API.

Use Service Port Forwarding instead when the result needs a long-running process, API, database connection, WebSocket, or server-side state.
When employee login is configured, new publications default to `employee` access.
The managed server authenticates every file, including JSON, images and downloads,
before loading it. Explicitly public material uses `--access public`. Instances
without employee identity configuration retain the existing public default.
Dynamic loopback services use `remotelab preview expose`; see
[employee site login](../employee-site-login.md) for the shared login contract.

## Publish

```bash
remotelab publish static --source ./dist --slug my-report --json
```

The source may be one HTML file or a directory containing `index.html`. Use `--replace`
only when intentionally updating the same stable slug. Replacements retain the
original owner, reserved administrators and access unless `--access` is explicit;
legacy public publications remain public. `--access employee` requires configured
Feishu identity and a verified creator. `--access public` explicitly publishes
without employee login.

Management commands:

```bash
remotelab publish list --json
remotelab publish delete my-report --json
```

## Storage and delivery contract

- Default storage is the instance-local `public-pages` directory under RemoteLab's configured data root.
- Override the storage location with `REMOTELAB_PUBLIC_PAGES_DIR` when the host needs a dedicated volume.
- Public publications may override the URL base with `REMOTELAB_PUBLIC_PAGES_BASE_URL`. Employee publications must use the managed instance `/public-pages` ingress; a separate file server would bypass its login check.
- The command returns a public URL when public ingress is configured and a loopback URL otherwise.
- For public content, verify the URL resolves directly to the intended page.
- For employee content, the publisher verifies anonymous rejection; a failed
  boundary check rolls back the publication. Its result explicitly reports
  `contentVerified: false`: also verify the content using an employee login.
  A login page alone is not proof the intended content is readable.
- Owner/access metadata is hidden from static HTTP access; employee content uses
  private, no-store responses. Do not place a bypassing static ingress over this directory.

## Safety

- Run an automatic recursive secret/private-data scan and publish when the output is clean, scoped, and reversible. Do not wait for optional human review. Pause only when unresolved personal data, credentials, raw contact lists, tokenized URLs, or material legal/brand risk remains, and make that blocker visible with a recovery path.
- The publisher skips hidden files, VCS data, `node_modules`, caches, and symbolic links.
- Prefer a new slug for important snapshots. Use `--allow-large` only after inspecting the source tree.
