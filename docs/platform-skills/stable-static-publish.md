# Stable Static Publish

Use for 网页预览, 静态网页, demo 链接, Pages 部署, static site, or any user-openable delivery whose output is a directory of static files.

## Routing decision

- Static build output: publish to an authenticated, fixed static-hosting project such as Cloudflare Pages. Reuse the same project and production branch so its `project.pages.dev` URL remains stable across deployments.
- Dynamic or stateful service: supervise a loopback-only origin and use Guest Port Expose.
- Never automatically use a Cloudflare Quick Tunnel. It is allowed only when the user explicitly asks for a one-off isolated experiment, and it is never a formal delivery URL.

## Cloudflare Pages pattern

Check authorization and existing projects first:

```bash
npx wrangler whoami
npx wrangler pages project list
```

Create the fixed project only when it does not exist, then always deploy the production branch:

```bash
npx wrangler pages project create <project> --production-branch main
npx wrangler pages deploy dist --project-name <project> --branch main
```

Do not accept Wrangler temporary deployments as delivery. If authentication is unavailable, report that checkpoint instead of creating an unstable link.

## Delivery checks

- Build output contains the expected site marker.
- The fixed public URL returns HTTP 200 in a fresh anonymous request without redirecting to login.
- Two consecutive deployments report the same fixed project URL.
- The public URL remains healthy after the local build or preview process stops.
