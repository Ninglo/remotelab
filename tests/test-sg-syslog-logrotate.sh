#!/usr/bin/env bash
# Run the production policy against a synthetic log, not a live instance.
set -euo pipefail
if ! command -v logrotate >/dev/null || ! command -v pigz >/dev/null; then
  echo 'SKIP: logrotate and pigz are required'; exit 77
fi
repo=$(cd -- "$(dirname -- "$0")/.." && pwd)
policy="$repo/scripts/remotelab-sg-syslog.logrotate"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
printf 'synthetic log entry\n' > "$tmp/syslog.seed"
cp -- "$tmp/syslog.seed" "$tmp/syslog"
printf 'legacy compressed log fixture\n' > "$tmp/syslog.2.gz"
legacy=$(sha256sum "$tmp/syslog.2.gz")
# Replace only fixture paths, ownership, size and the host-specific HUP hook.
awk -v dir="$tmp" -v user="$(id -un)" -v group="$(id -gn)" '
  /^\/var\/log\/syslog / {$1=dir "/syslog"}
  /su root adm/ {$2=user; $3=group}
  /create 0640 syslog adm/ {$3=user; $4=group}
  /maxsize 1G/ {$2="1k"}
  /\/usr\/lib\/rsyslog\/rsyslog-rotate/ {$1="/usr/bin/true"}
  {print}
' "$policy" > "$tmp/policy"
logrotate -s "$tmp/state" "$tmp/policy"
if compgen -G "$tmp/syslog-*.gz" >/dev/null; then echo 'unexpected small-log rotation'; exit 1; fi
for ((i=0;i<128;i++)); do printf 'synthetic log entry\n'; done >> "$tmp/syslog"
cp -- "$tmp/syslog" "$tmp/syslog.expected"
logrotate -s "$tmp/state" "$tmp/policy"
shopt -s nullglob
archives=("$tmp"/syslog-*.gz)
[[ ${#archives[@]} -eq 1 && ! -s $tmp/syslog ]]
pigz -t "${archives[0]}"
cmp "$tmp/syslog.expected" <(pigz -dc "${archives[0]}")
[[ "$(sha256sum "$tmp/syslog.2.gz")" == "$legacy" ]]
printf 'PASS: small log untouched, size rotation lossless, active file recreated, legacy archive untouched\n'
