# Test-only discovery/CLI fixture. All production d() calls are intercepted;
# live mode delegates only Compose help/config reads to the local Docker CLI.
cd() { test "$1" = "$sd_qa_dir"; }
d() {
    case "$1 $2" in
        'container ls')
            case "$*" in
                *project=shop*) printf '%s\n' "$sd_qa_a" "$sd_qa_b";;
                *project=other*) printf '%s\n' "$sd_qa_c";;
                *) printf '%s\n' "$sd_qa_a" "$sd_qa_b" "$sd_qa_c";;
            esac;;
        'container inspect')
            sd_qa_format=$4
            shift 5
            case "$sd_qa_format" in
                '{"Id":'*)
                    if test "$1" = "$sd_qa_c"; then printf '%s\n' "$sd_qa_other_meta"; else printf '%s\n' "$sd_qa_shop_meta"; fi;;
                *'{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}'*)
                    for sd_qa_member in "$@"; do
                        if test "$sd_qa_conflict" = true && test "$sd_qa_member" = "$sd_qa_b"; then printf '%s\n' '"/different" "/different/compose.yaml"';
                        else printf '%s\n' "$sd_qa_identity"; fi
                    done;;
                *com.docker.compose.project.working_dir*) printf '%s\n' "$sd_qa_dir";;
                *com.docker.compose.project.config_files*) printf '%s\n' "$sd_qa_files";;
                *com.docker.compose.project*)
                    if test "$1" = "$sd_qa_c"; then printf '%s\n' other; else printf '%s\n' shop; fi;;
                *) printf 'unexpected inspect format\n' >&2; return 90;;
            esac;;
        'compose config')
            test "$3" = --help || return 91
            if test "$sd_qa_live" = true; then command docker --host unix://$sd_socket "$@";
            elif test "$sd_qa_modern" = true; then printf '%s\n' '--format --no-interpolate --no-env-resolution';
            else printf '%s\n' '--format --no-interpolate'; fi;;
        'compose --project-name')
            if test "$3" = other; then printf 'unrelated project denied\n' >&2; return 13; fi
            test "$3" = shop && test "$4" = --project-directory && test "$5" = "$sd_qa_dir" || return 92
            test "$6" = --profile && test "$7" = '*' && test "$8" = --file && test "$9" = "$sd_qa_file1" || return 93
            shift 9
            test "$1" = --file && test "$2" = "$sd_qa_file2" && test "$3" = config && test "$4" = --format && test "$5" = json || return 94
            shift 5
            if test "$sd_reveal" = false; then
                test "$1" = --no-interpolate || return 95
                shift
                if test "$sd_qa_modern" = true; then test "$1" = --no-env-resolution || return 96; shift; fi
            fi
            if test "$#" -ne 0; then printf 'unknown flag: %s\n' "$1" >&2; return 97; fi
            if test "$sd_qa_live" = true; then
                set -- compose --project-name shop --project-directory "$sd_qa_dir" --profile '*' --file "$sd_qa_file1" --file "$sd_qa_file2" config --format json
                if test "$sd_reveal" = false; then
                    set -- "$@" --no-interpolate
                    if test "$sd_can_skip_env" = true; then set -- "$@" --no-env-resolution; fi
                fi
                command docker --host unix://$sd_socket "$@"
            else printf '%s\n' "$sd_qa_model"; fi;;
        *) printf 'unexpected Docker operation\n' >&2; return 98;;
    esac
}
