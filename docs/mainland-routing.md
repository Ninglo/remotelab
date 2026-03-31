# Mainland Routing

Mainland natapp access should use one rule everywhere: every product surface lives under `/{name}/`.

## Rules

- Use `https://<mainland-base>/<name>/...` for every mainland product surface.
- Keep the main owner service on a named prefix too. The default is `/owner/`, but the actual name is configurable.
- Treat the bare root as a neutral route index, not as a product surface.
- Do not silently repoint an existing mainland path from one instance to another.
- When routing data drifts, prefer the live launch-agent `CHAT_PORT` over a stale guest-registry port.

## Why

- A prefix-only scheme keeps mainland ingress aligned with the rest of the product's session and instance model.
- Silent root aliases make failures ambiguous: browser auth, product auth, and provider auth can all look like one broken path when the target behind that path changes.
- Named prefixes make it obvious which runtime the user is entering before any login or model session starts.

## Current Mainland Shape

- Guest instances use their instance name: `/trial4/`, `/trial24/`, `/intake1/`, and so on.
- The main owner service uses a configured service name, defaulting to `/owner/`.
- The root path only lists known prefixes so users can recover the right entry without preserving a second routing model.

## Compatibility

- `NATAPP_MAINLAND_SERVICE_NAME` controls the named mainland prefix for the main service.
- `NATAPP_MAINLAND_SERVICE_PORT` controls the local upstream for that named mainland service.
- Legacy `NATAPP_OWNER_ROUTE_PREFIX` and `NATAPP_OWNER_UPSTREAM_PORT` still work as compatibility aliases.
- `NATAPP_ROOT_MODE=legacy-proxy` remains available only as an emergency compatibility escape hatch. It is not the recommended product shape.

## Legacy Cases To Retire

- Root-path product aliases such as “the mainland root currently means trial4” or “the mainland root currently means owner”.
- Registry records that still point a guest instance at the mainland proxy port instead of its live chat-server port.
- Docs or ops habits that describe mainland access as a mix of root aliases and prefixed paths.
