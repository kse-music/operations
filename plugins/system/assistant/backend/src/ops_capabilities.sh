printf 'SDOPS1\000'
if command -v docker >/dev/null 2>&1; then
 printf '1\000'
 d version --format '{{json .}}'
 printf '\000%s\000' "$?"
else printf '0\000\000127\000'; fi
if test -d /run/systemd/system && command -v systemctl >/dev/null 2>&1; then printf '1\000'; else printf '0\000'; fi
command -v ps >/dev/null 2>&1 && printf '1\000' || printf '0\000'
command -v ss >/dev/null 2>&1 && printf '1\000' || printf '0\000'
command -v python3 >/dev/null 2>&1 && printf '1\000' || printf '0\000'
exit 0
