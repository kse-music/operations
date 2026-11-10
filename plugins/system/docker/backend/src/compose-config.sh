set -f
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE
sd_help=$(d compose config --help) || exit
sd_can_skip_env=false
case "$sd_help" in *--no-env-resolution*) sd_can_skip_env=true;; esac
sd_ids=$(d container ls --all --quiet --no-trunc --filter label=com.docker.compose.project) || exit
sd_seen='|'

sd_valid_id() {
    test "${#1}" -eq 64 || return 1
    case "$1" in *[!a-fA-F0-9]*) return 1;; esac
}
sd_label() {
    # A sentinel preserves trailing newlines so control characters are rejected.
    sd_value=$(d container inspect --format "{{index .Config.Labels \"$2\"}}" -- "$1" && printf '.') || return
    sd_value=${sd_value%.}
    sd_value=${sd_value%?}
    case "$sd_value" in ''|'<no value>'|*[[:cntrl:]]*) return 1;; esac
}
sd_path() {
    test "${#1}" -le 4096 || return 1
    case "$1" in /*) ;; *) return 1;; esac
    case "$1" in *[[:cntrl:]]*) return 1;; esac
}
sd_read_config() {
    sd_label "$sd_id" com.docker.compose.project.working_dir || { printf '%s\n' '项目工作目录缺失或包含控制字符' >&2; return 2; }
    sd_dir=$sd_value
    sd_path "$sd_dir" || { printf '%s\n' '项目工作目录不是有效绝对路径' >&2; return 2; }
    sd_label "$sd_id" com.docker.compose.project.config_files || { printf '%s\n' '项目配置文件标签缺失或包含控制字符' >&2; return 2; }
    sd_files=$sd_value
    sd_identity=$(d container inspect --format '{{json (index .Config.Labels "com.docker.compose.project.working_dir")}} {{json (index .Config.Labels "com.docker.compose.project.config_files")}}' -- "$sd_id") || return
    sd_identities=$(d container inspect --format '{{json (index .Config.Labels "com.docker.compose.project.working_dir")}} {{json (index .Config.Labels "com.docker.compose.project.config_files")}}' -- $sd_members) || return
    sd_conflict=$(printf '%s\n' "$sd_identities" | while IFS= read -r sd_line; do
        if test "$sd_line" != "$sd_identity"; then printf conflict; break; fi
    done)
    test -z "$sd_conflict" || { printf '%s\n' '同名项目的工作目录或有序配置文件不一致' >&2; return 2; }
    set -- compose --project-name "$sd_project" --project-directory "$sd_dir" --profile '*'
    sd_count=0
    while :; do
        case "$sd_files" in
            *,*) sd_file=${sd_files%%,*}; sd_files=${sd_files#*,}; sd_more=true;;
            *) sd_file=$sd_files; sd_more=false;;
        esac
        sd_path "$sd_file" || { printf '%s\n' '项目配置文件不是有效绝对路径' >&2; return 2; }
        sd_count=$((sd_count + 1))
        test "$sd_count" -le 16 || { printf '%s\n' '项目配置文件超过 16 个' >&2; return 2; }
        set -- "$@" --file "$sd_file"
        test "$sd_more" = true || break
    done
    set -- "$@" config --format json
    if test "$sd_reveal" = false; then
        set -- "$@" --no-interpolate
        if test "$sd_can_skip_env" = true; then set -- "$@" --no-env-resolution; fi
    fi
    (cd "$sd_dir" && d "$@")
}

for sd_id in $sd_ids; do
    sd_valid_id "$sd_id" || { printf '%s\n' 'Docker 返回无效容器 ID' >&2; exit 2; }
    sd_label "$sd_id" com.docker.compose.project || continue
    sd_project=$sd_value
    case "$sd_project" in *[!a-z0-9_-]*|[-_]*) continue;; esac
    test "${#sd_project}" -le 255 || continue
    case "$sd_seen" in *"|$sd_project|"*) continue;; esac
    sd_seen=$sd_seen$sd_project'|'
    sd_meta=$(d container inspect --format '{"Id":{{json .Id}},"Project":{{json (index .Config.Labels "com.docker.compose.project")}},"WorkingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"ConfigFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}' -- "$sd_id") || continue
    printf '\nSERVERDECK_COMPOSE_BEGIN %s\n' "$sd_id" >&2
    sd_members=$(d container ls --all --quiet --no-trunc --filter "label=com.docker.compose.project=$sd_project") || exit
    sd_members_json=''
    for sd_member in $sd_members; do
        sd_valid_id "$sd_member" || exit 2
        sd_members_json=$sd_members_json'"'$sd_member'",'
    done
    sd_model=$(sd_read_config)
    sd_status=$?
    test "$sd_status" -eq 0 || sd_model=null
    sd_resolved=true
    if test "$sd_reveal" = false && test "$sd_can_skip_env" = true; then sd_resolved=false; fi
    printf '%s,"Members":[%s],"Model":%s,"ExitCode":%s,"EnvironmentFilesResolved":%s}\n' "${sd_meta%?}" "${sd_members_json%,}" "$sd_model" "$sd_status" "$sd_resolved"
    printf 'SERVERDECK_COMPOSE_END %s\n' "$sd_id" >&2
done
