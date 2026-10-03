#!/usr/bin/env bash
# Internal launcher. The Node parent validates and creates these paths first.
set -euo pipefail
root=$1
input=$2
output=$3
runtime=$4
mount --make-rprivate /
mkdir -p "$root"/{usr,lib,lib64,etc,dev,proc,input,output,app,tmp,runtime}
mount --bind "$root" "$root"
for dir in usr lib lib64; do
  if [[ -e /$dir ]]; then
    mount --bind "/$dir" "$root/$dir"
    mount -o remount,bind,ro "$root/$dir"
  fi
done
touch "$root/etc/ld.so.cache" "$root/dev/null" "$root/dev/urandom" "$root/runtime/node"
mount --bind /etc/ld.so.cache "$root/etc/ld.so.cache"
mount -o remount,bind,ro "$root/etc/ld.so.cache"
for name in null urandom; do
  mount --bind "/dev/$name" "$root/dev/$name"
  mount -o remount,bind,ro "$root/dev/$name"
done
mount --bind "$runtime" "$root/runtime/node"
mount -o remount,bind,ro "$root/runtime/node"
mount --bind "$input" "$root/input"
mount -o remount,bind,ro "$root/input"
mount --bind "$output" "$root/output"
mount -t proc proc "$root/proc" -o nosuid,nodev,noexec
mount -t tmpfs tmpfs "$root/tmp" -o size=16m,nosuid,nodev,noexec
# Root and application material are immutable; only /output and bounded /tmp write.
mount -o remount,bind,ro "$root"
ulimit -t 30
ulimit -f 65536
ulimit -n 64
ulimit -v 2097152
renice -n 19 -p $$ >/dev/null
cd "$root"
exec /usr/sbin/chroot "$root" /usr/bin/setpriv --no-new-privs \
  --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
  /runtime/node --max-old-space-size=256 --no-addons /input/worker.mjs
