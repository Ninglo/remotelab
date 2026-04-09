# RemoteLab Control-Plane Runbook

This runbook records the live control-plane shape that was landed after the Hetzner fallback and the first DigitalOcean rollout.

It is written for repeated operator use. Do not put secrets, PATs, auth tokens, or tunnel credentials in this file.

## Current Shape

### DigitalOcean control plane

- provider: DigitalOcean
- droplet: `remotelab-sfo3-01`
- region: `sfo3`
- size: `s-2vcpu-4gb`
- image: `ubuntu-24-04-x64`
- primary owner service: `remotelab` on `127.0.0.1:7690`
- primary public ingress: Cloudflare Tunnel on `https://thelab.jiujianian.dev`

### Legacy mainland compatibility

- legacy mainland hostname: `https://jojotry.nat100.top`
- legacy mainland tunnel still belongs to the local Mac compatibility path
- legacy public trial routes continue to terminate on the local Mac through the old natapp flow
- local mainland bridge port: `127.0.0.1:7699`

### Important split

- `thelab.jiujianian.dev` is the new DigitalOcean control-plane entrypoint
- `jojotry.nat100.top` is the old mainland compatibility entrypoint
- do not treat them as interchangeable

## Non-Negotiable Rules

### Natapp rule

- one natapp tunnel is effectively one active server attachment point
- do not move the existing `jojotry` natapp token to DigitalOcean while legacy `trial*` compatibility is still required
- if DigitalOcean needs its own mainland natapp-style ingress, provision a separate tunnel

### Compatibility rule

- legacy `jojotry.nat100.top/trial*` links must keep pointing at the local Mac path until there is an explicit migration plan
- do not silently repoint legacy mainland routes from one host to another

### Secrets rule

- keep access tokens out of this repo
- owner access tokens live in host-side auth files, not in documentation

## Live Services

### On the DigitalOcean host

- `remotelab`
- `cloudflared-thelab`
- `remotelab-mainland-proxy`
- `natapp-mainland`

Current intent:

- `remotelab` should be active
- `cloudflared-thelab` should be active
- `natapp-mainland` should stay disabled unless a separate mainland tunnel is intentionally provisioned for the DigitalOcean host
- `remotelab-mainland-proxy` may exist on the host, but it is not the active public mainland path while `jojotry` remains on the local Mac

### On the local Mac

- launch agent: `com.remotelab.natapp.dual-proxy`
- launch agent: `cn.natapp.jojotry.7699`

## Access Model

### Owner access

- public hostname: `https://thelab.jiujianian.dev`
- access pattern: `https://thelab.jiujianian.dev/?token=<owner-token>`
- owner token source: host-side auth file on the control-plane machine

### Legacy trial access

- public hostname: `https://jojotry.nat100.top`
- access pattern: `https://jojotry.nat100.top/<trial-name>/`
- mainland routing rule: prefix-only, one product surface per `/{name}/`

## Routine Commands

### Check the DigitalOcean host

```bash
ssh -o StrictHostKeyChecking=no -i ~/.ssh/remotelab_do_ed25519 root@146.190.59.141
```

```bash
ssh -o StrictHostKeyChecking=no -i ~/.ssh/remotelab_do_ed25519 root@146.190.59.141 \
  'systemctl is-active remotelab cloudflared-thelab remotelab-mainland-proxy natapp-mainland'
```

```bash
ssh -o StrictHostKeyChecking=no -i ~/.ssh/remotelab_do_ed25519 root@146.190.59.141 \
  'ss -ltnp | egrep ":(7690|7699)\s"'
```

### Check the local mainland compatibility path

```bash
launchctl list | rg 'cn.natapp.jojotry.7699|com.remotelab.natapp.dual-proxy'
```

```bash
lsof -nP -iTCP:7699 -sTCP:LISTEN
```

```bash
curl -k -sSI https://jojotry.nat100.top/
curl -k -sSI https://jojotry.nat100.top/trial24/
```

### Start the local mainland compatibility services

```bash
launchctl load ~/Library/LaunchAgents/com.remotelab.natapp.dual-proxy.plist
launchctl load ~/Library/LaunchAgents/cn.natapp.jojotry.7699.plist
```

### Stop the local mainland compatibility services

```bash
launchctl unload ~/Library/LaunchAgents/cn.natapp.jojotry.7699.plist
launchctl unload ~/Library/LaunchAgents/com.remotelab.natapp.dual-proxy.plist
```

### Keep the portable memory mirrored to DigitalOcean

```bash
rsync -az --delete \
  -e 'ssh -o StrictHostKeyChecking=no -i ~/.ssh/remotelab_do_ed25519' \
  ~/.remotelab/memory/ \
  root@146.190.59.141:/root/.remotelab/memory/
```

## Recovery Playbooks

### If old `trial*` links stop working

1. Check whether `natapp-mainland` was accidentally enabled on DigitalOcean.
2. If yes, disable it on DigitalOcean.
3. Reload the two local launch agents.
4. Verify `127.0.0.1:7699` is listening locally.
5. Verify a known public route such as `https://jojotry.nat100.top/trial24/` returns a login redirect instead of a 404 or timeout.

Suggested commands:

```bash
ssh -o StrictHostKeyChecking=no -i ~/.ssh/remotelab_do_ed25519 root@146.190.59.141 \
  'systemctl disable --now natapp-mainland'
```

```bash
launchctl load ~/Library/LaunchAgents/com.remotelab.natapp.dual-proxy.plist
launchctl load ~/Library/LaunchAgents/cn.natapp.jojotry.7699.plist
```

### If the DigitalOcean owner service is down

1. Check `remotelab` and `cloudflared-thelab`.
2. Verify `127.0.0.1:7690` on the host.
3. Verify `https://thelab.jiujianian.dev` redirects to `/login`.
4. If needed, restart the two systemd units.

Suggested commands:

```bash
ssh -o StrictHostKeyChecking=no -i ~/.ssh/remotelab_do_ed25519 root@146.190.59.141 \
  'systemctl restart remotelab cloudflared-thelab && systemctl is-active remotelab cloudflared-thelab'
```

## Scaling Notes

### Why natapp is not the long-term mainland scale path

- reusing one natapp tunnel across the local Mac and DigitalOcean breaks compatibility
- one tunnel per trial does not scale cleanly for dozens or hundreds of trial instances

### Preferred direction for new mainland ingress

There are two reasonable future paths:

- managed wildcard ingress such as cpolar with one wildcard domain plus a host-routing reverse proxy on the DigitalOcean host
- self-hosted ingress such as `frp` with wildcard subdomain routing

Either way, the scalable shape is:

- one shared ingress edge
- many subdomains
- host-based routing behind that edge

Avoid a design where every trial consumes a separate tunnel.

## Operator Checklist Before Any Ingress Change

- confirm whether legacy `jojotry` compatibility must survive the change
- confirm whether the change touches the local Mac, the DigitalOcean host, or both
- confirm whether the proposal introduces a shared credential across two hosts
- confirm whether the plan increases tunnel count linearly with trial count
- verify one public owner URL and one public trial URL after the change
