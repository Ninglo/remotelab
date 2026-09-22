# Tunnel diagnostics

Use `scripts/tunnel-latency-diagnose.mjs` when Cloudflare Tunnel feels slow and you need to separate:

- local app time on `127.0.0.1:7690`
- Cloudflare edge time on the public hostname
- tunnel round-trip overhead that remains even when the app is fast locally

## Fast start

Run the default probe set:

```bash
npm run diag:tunnel
```

Probe specific routes:

```bash
npm run diag:tunnel -- \
  --path /api/sessions?view=refs \
  --path /api/models \
  --path /chat/ui.js \
  --warm 3
```

Use a manual public hostname when auto-detection is wrong:

```bash
npm run diag:tunnel -- --remote-base https://remotelab.example.com
```

## What the script does

- reads `~/.cloudflared/config.yml` to find the port `7690` hostname
- reuses the primary web token from `~/.config/remotelab/auth.json` for `/api/*` probes
- appends a unique `_perf=...` query marker to every `/api/*` request
- matches that marker against `~/.config/remotelab/api-logs/*.jsonl` to recover the app's own `responseStartMs` / `durationMs`
- probes `/cdn-cgi/trace` on the same hostname so you can see the current Cloudflare colo
- calls `cloudflared tunnel info <name>` when available so you can see which edge locations the connector is attached to

## How to read the output

- `local 200` is the direct origin baseline. If this is already slow, fix the app before blaming Tunnel.
- `remote 200 cold` includes DNS + TCP + TLS + the tunnel hop.
- `remote 200 warm median` keeps the same connection open across multiple requests. If this is still much slower than local, the cost is not just TLS handshake.
- `local conditional` shows how expensive a would-be `304` is on the app itself.
- `remote conditional` shows the real world cost of a `304` over the tunnel.

Useful rules of thumb:

- If `/chat/ui.js` or another static file is slow remotely but fast locally, the bottleneck is outside the app.
- If static `304` is still hundreds of milliseconds warm, Cloudflare path latency is dominating.
- If `/api/*` local conditional requests already take tens of milliseconds, the current ETag path is also doing real work on the app before returning `304`.
- If `/cdn-cgi/trace` says `loc=CN` but `colo=LAX`, this machine is crossing the Pacific just to reach Cloudflare. Tunnel requests then pay that distance twice: client → edge and edge → connector.

## Interpreting the likely outcome

This script is designed to answer the product question “should we keep Cloudflare Tunnel here or switch ingress?” with evidence:

- keep Tunnel when the local app is the clear bottleneck and the tunnel adds little
- optimize app caching when local `304` work is large
- consider another ingress path when static assets and stable `304`s are still slow over the tunnel while local origin is fast
