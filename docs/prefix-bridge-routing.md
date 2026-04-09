# Prefix Bridge Routing

RemoteLab treats path-prefixed bridge ingress as an optional auxiliary surface, not the primary routing model. Primary product entrypoints should use dedicated hostnames such as `thelab.jiujianian.dev` and `owner.jiujianian-dev-world.win`.

## Rules

- Prefer dedicated hostnames for product entrypoints.
- Keep path-prefixed bridge ingress disabled unless a specific deployment still depends on it.
- Do not silently repoint an existing prefixed path from one instance to another.
- When routing data drifts, prefer the live launch-agent `CHAT_PORT` over a stale guest-registry port.

## Why

- Dedicated hostnames keep auth, cookies, and install/bootstrap flows simpler.
- Silent root aliases and legacy prefixed paths make failures ambiguous: browser auth, product auth, and provider auth can all look like one broken path when the target behind that path changes.
- If a deployment still needs prefixed ingress temporarily, it should be treated as an explicit bridge with an explicit retirement plan.

## Current Prefix-Bridge Shape

- The live deployment should use subdomain-style hostnames for owner and guest-facing entrypoints.
- Legacy path-prefixed bridges such as `/owner/` should stay disabled unless they are explicitly re-enabled for a temporary migration.

## Configuration

- `NATAPP_BRIDGE_SERVICE_NAME` controls the named prefix for the main service when the prefix bridge is enabled.
- `NATAPP_BRIDGE_SERVICE_PORT` controls the local upstream for that named bridge service.
- `NATAPP_ROOT_MODE=proxy` remains available only as an emergency escape hatch. It is not the recommended product shape.

## Legacy Cases To Retire

- Root-path product aliases such as “the root currently means trial4” or “the root currently means owner”.
- Registry records that still point a guest instance at the prefix bridge port instead of its live chat-server port.
- Docs or ops habits that describe bridge access as a mix of root aliases, prefixed paths, and hostnames.
