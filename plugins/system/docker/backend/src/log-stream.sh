export LC_ALL=C
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
sd_timeout=$(timeout --version 2>/dev/null) || { echo 'Docker log viewing requires GNU coreutils timeout' >&2; exit 127; }
case "$sd_timeout" in *'GNU coreutils'*) ;; *) echo 'Docker log viewing requires GNU coreutils timeout' >&2; exit 127;; esac
sd_guard=$$
sd_reader=
sd_watch=
sd_cleanup() {
    trap '' HUP INT TERM USR1
    if test -n "$sd_watch"; then
        kill -TERM "$sd_watch" 2>/dev/null || :
        wait "$sd_watch" 2>/dev/null || :
    fi
    if test -n "$sd_reader"; then
        # GNU timeout forwards TERM to its own process group, then KILL after 1s.
        kill -TERM "$sd_reader" 2>/dev/null || :
        wait "$sd_reader" 2>/dev/null || :
    fi
}
trap sd_cleanup 0
trap 'exit 130' HUP INT TERM USR1
exec 3<&0
timeout --kill-after=1s 10m sh -c __SD_LOG_COMMAND__ </dev/null 3<&- &
sd_reader=$!
(
    while IFS= read -r sd_input; do :; done
    kill -USR1 "$sd_guard" 2>/dev/null || :
) <&3 3<&- &
sd_watch=$!
exec 3<&-
wait "$sd_reader"
sd_status=$?
sd_reader=
if test "$sd_status" -eq 124; then
    echo 'Docker log session reached the 10 minute limit; reopen logs to continue.' >&2
fi
exit "$sd_status"
