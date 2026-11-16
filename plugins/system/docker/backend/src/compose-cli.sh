sd_compose_entry=
sd_compose_legacy=false
sd_compose_modern() {
    sd_compose_major=${1#v}
    sd_compose_major=${sd_compose_major%%.*}
    case "$sd_compose_major" in ''|*[!0-9]*) return 1;; esac
    test "$sd_compose_major" -ge 2
}
sd_compose_select() {
    test -z "$sd_compose_entry" || return 0
    sd_compose_plugin_version=$(d compose version --short 2>&1)
    sd_compose_plugin_status=$?
    if test "$sd_compose_plugin_status" -eq 0 && sd_compose_modern "$sd_compose_plugin_version"; then
        sd_compose_entry=plugin
        return 0
    fi
    sd_compose_standalone_version=$(DOCKER_HOST="unix://$sd_socket" command docker-compose version --short 2>&1)
    sd_compose_standalone_status=$?
    if test "$sd_compose_standalone_status" -eq 0 && sd_compose_modern "$sd_compose_standalone_version"; then
        sd_compose_entry=standalone
        return 0
    fi
    if test "$sd_compose_standalone_status" -eq 0; then
        case "$sd_compose_standalone_version" in
            1.29.2|v1.29.2) sd_compose_entry=standalone; sd_compose_legacy=true; return 0;;
        esac
    fi
    sd_compose_reason='Compose 不可用；支持 docker-compose 1.29.2 和 Compose V2 或后续版本，容器及镜像管理仍可使用。'
    printf '%s\n' "$sd_compose_reason" "docker-compose: $sd_compose_standalone_version" "docker compose: $sd_compose_plugin_version" >&2
    return 127
}
dc() {
    sd_compose_select || return
    if test "$sd_compose_entry" = plugin; then
        d compose "$@"
    else
        DOCKER_HOST="unix://$sd_socket" command docker-compose "$@"
    fi
}
sd_compose_exec() {
    sd_compose_select || exit
    if test "$sd_compose_entry" = plugin; then
        exec docker --host "unix://$sd_socket" compose "$@"
    else
        export DOCKER_HOST="unix://$sd_socket"
        exec docker-compose "$@"
    fi
}
