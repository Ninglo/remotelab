#!/bin/sh
# Host operator runs this as systemd ExecStartPre=+... in a delegated unit.
# The old main PID must have exited; remaining root-leaf PIDs are preserved.
set -eu
unit=${1:?service unit}; device=${2:?backing block device}; owner=${3:?runner owner}
read_bps=${4:?bytes per second}; read_iops=${5:?read IOPS}
write_bps=${6:-max}; write_iops=${7:-max}
case "$unit" in ''|*[!a-zA-Z0-9_.@-]*|.*) exit 2;; esac
base=/sys/fs/cgroup/system.slice/$unit
case "$(/usr/bin/lsblk -dnro MAJ:MIN "$device")" in
  *:*) dev=$(/usr/bin/lsblk -dnro MAJ:MIN "$device");;
  *) echo 'Runner I/O device could not be resolved' >&2; exit 2;;
esac
[ "$(/usr/bin/stat -fc %T "$base")" = cgroup2fs ]
# Scope the privileged startup helper to its own owning unit; systemd puts
# ExecStartPre in .control when DelegateSubgroup is in use.
/usr/bin/grep -Fxq "0::/system.slice/$unit/.control" /proc/self/cgroup
bulk=$base/runner-bulk
mkdir -p "$bulk"
# KillMode=process intentionally preserves old detached runners. Move only
# direct members of our unit, without signalling them. New descendants inherit
# the subgroup once their parent has moved. No unrelated services are touched.
for pass in 1 2 3; do
    while IFS= read -r pid; do
        [ -n "$pid" ] || continue
        if ! /usr/bin/grep -Fxq "0::/system.slice/$unit" "/proc/$pid/cgroup" 2>/dev/null; then continue; fi
        if ! (printf '%s\n' "$pid" > "$bulk/cgroup.procs"); then
            [ ! -e "/proc/$pid" ] || exit 1
        fi
    done < "$base/cgroup.procs"
    if ( ! IFS= read -r unused ) < "$base/cgroup.procs"; then break; fi
done
printf '+io\n' > "$base/cgroup.subtree_control"
printf '%s rbps=%s riops=%s wbps=%s wiops=%s\n' "$dev" "$read_bps" "$read_iops" "$write_bps" "$write_iops" > "$bulk/io.max"
chown "$owner" "$bulk/cgroup.procs"
/usr/bin/grep -F "$dev " "$bulk/io.max"
