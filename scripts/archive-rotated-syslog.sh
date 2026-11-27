#!/usr/bin/env bash
# Losslessly reclaim root disk space from the closed, delaycompress syslog slot.
# Production: sudo scripts/archive-rotated-syslog.sh --apply
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077
mode=${1:---dry-run}
case "$mode" in --dry-run|--apply) ;; *) echo 'use --dry-run or --apply' >&2; exit 2;; esac
(( $# <= 1 )) || exit 2
src=/var/log/syslog.1
archive=/data/remotelab-maintenance/retained-syslog
[[ $EUID == 0 ]] || { echo 'requires root'; exit 2; }
[[ "$(findmnt -n -o TARGET --target /data)" == /data ]] || { echo 'data disk not mounted'; exit 2; }
[[ "$(stat -c %d /)" != "$(stat -c %d /data)" ]] || { echo 'destination is on root disk'; exit 2; }
[[ -f /var/lib/logrotate/status && ! -L /var/lib/logrotate/status ]] || exit 2
exec 8<>/var/lib/logrotate/status
flock -xn 8 || { echo 'logrotate lock busy'; exit 3; }
[[ -e $src || -L $src ]] || { echo 'no uncompressed rotated syslog'; exit 0; }
[[ -f $src && ! -L $src && "$(stat -c '%h %a %U %G' -- "$src")" == '1 640 syslog adm' ]] || { echo 'unexpected rotated log type, links, owner or mode'; exit 2; }
sig=$(stat -c '%d:%i:%s:%y:%z' -- "$src")
bytes=$(stat -c %s -- "$src")
[[ $bytes -ge $((512*1024*1024)) ]] || { echo 'rotated syslog below 512 MiB'; exit 0; }
# Reserve space for worst-case output, not an estimated compression ratio.
free=$(df -B1 --output=avail /data | tail -1)
(( free > bytes + bytes/100 + 20*1024*1024*1024 )) || { echo 'insufficient data-disk headroom for lossless archive'; exit 2; }
[[ "$mode" == --apply ]] || { printf 'eligible rotated syslog: %s bytes; no changes\n' "$bytes"; exit 0; }
if [[ ! -e $archive ]]; then install -d -m 0700 -o root -g root -- "$archive"; fi
[[ ! -L $archive && "$(realpath -- "$archive")" == "$archive" && "$(stat -c '%a:%u:%d' -- "$archive")" == "700:0:$(stat -c %d /data)" ]] || exit 2
# Avoid piping private log contents into the caller's terminal or receipt.
closed() {
  # Scan fd link text without resolving remote filesystems; a stale FUSE mount
  # can hang a whole-host lsof. The source must have exactly one local link.
  python3 - "$src" <<'PY'
import os, sys
source = sys.argv[1]
for process in os.scandir('/proc'):
    if not process.name.isdecimal(): continue
    try:
        with os.scandir(process.path + '/fd') as fds:
            for fd in fds:
                try:
                    if os.readlink(fd.path) in (source, source + ' (deleted)'):
                        sys.exit(1)
                except FileNotFoundError:
                    continue
    except (FileNotFoundError, ProcessLookupError):
        continue
PY
}
closed || { echo 'rotated log open or handle check incomplete'; exit 2; }
cd -- "$archive"
tmp=$(mktemp .pending.XXXXXXXX)
trap 'rm -f -- "$tmp"' EXIT
sha=$(sha256sum -- "$src"); sha=${sha%% *}
shopt -s nullglob
matches=(syslog.*."${sha}".zst)
if (( ${#matches[@]} > 0 )); then
  out=${matches[0]}
  [[ -f $out && ! -L $out && "$(stat -c '%u:%a' -- "$out")" == '0:600' ]] || exit 2
  candidate=$out
else
  out="syslog.$(date -u +%Y%m%dT%H%M%SZ).${sha}.zst"
  candidate=$tmp
  zstd -q -T2 -3 --check -c -- "$src" > "$tmp"
fi
# zstd content checksum plus independent SHA-256 of the decompressed bytes.
actual=$(zstd -q -dc -- "$candidate" | sha256sum); actual=${actual%% *}
[[ "$actual" == "$sha" && "$(stat -c '%d:%i:%s:%y:%z' -- "$src")" == "$sig" ]] || { echo 'archive integrity/source stability check failed'; exit 2; }
encoded=$(stat -c %s -- "$candidate")
[[ $encoded -lt $bytes ]] || { echo 'archive would not reduce occupied bytes'; exit 2; }
sync -- "$candidate"
if [[ $candidate == "$tmp" ]]; then mv -T -- "$tmp" "$out"; fi
sync -- .
closed && [[ "$(stat -c '%d:%i:%s:%y:%z' -- "$src")" == "$sig" ]] || { echo 'source changed; verified copy retained, original untouched'; exit 2; }
rm -- "$src"
sync -- /var/log
printf 'archived_bytes=%s archive_bytes=%s sha256=%s archive=%s\n' "$bytes" "$encoded" "$sha" "$archive/$out"
