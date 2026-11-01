export LC_ALL=C
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
printf 'SDMON1\000'
part() {
    printf '%s\000' "$1"
    shift
    "$@"
    result=$?
    printf '\000%s_code\000%s\000' "$section" "$result"
}
section=stat; part stat head -c 262145 /proc/stat
section=memory; part memory head -c 65537 /proc/meminfo
section=uptime; part uptime cat /proc/uptime
section=boot; part boot cat /proc/sys/kernel/random/boot_id
section=load; part load cat /proc/loadavg
section=hostname; part hostname cat /proc/sys/kernel/hostname
section=kernel; part kernel uname -r
section=arch; part arch uname -m
section=os; part os head -c 16385 /etc/os-release
section=cpuinfo; part cpuinfo head -c 65536 /proc/cpuinfo
section=time; part time date '+%Y-%m-%dT%H:%M:%S%z %Z'
printf 'timezone\000'
if test -r /etc/timezone; then head -c 1024 /etc/timezone
else readlink /etc/localtime
fi
printf '\000'
section=net; part net head -c 65537 /proc/net/dev
section=addresses; part addresses ip -o address show
printf 'indices\000'
for interface in /sys/class/net/*; do
    test -r "$interface/ifindex" || continue
    printf '%s ' "${interface##*/}"
    cat "$interface/ifindex"
done
printf '\000'
section=mounts; part mounts head -c 524289 /proc/self/mountinfo
section=df; part df timeout -s KILL 4 df -P -k -T
exit 0
