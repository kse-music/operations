# Loaded only for an interactive Bash PTY. Profile files belong to the user.
if [[ -r /etc/profile ]]; then . /etc/profile; fi
for __sd_profile in ~/.bash_profile ~/.bash_login ~/.profile; do
    if [[ -r $__sd_profile ]]; then . "$__sd_profile"; break; fi
done
unset __sd_profile
__sd_token='__TOKEN__'
__sd_bash_version=$(( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] ))
__sd_b64() { printf '%s' "$1" | command base64 | tr -d '\r\n'; }
__sd_hist() { HISTTIMEFORMAT= builtin history 1; }
__sd_previous=$(__sd_hist)
__sd_activity() { printf '\033]777;sd-ssh;%s;%s;\007' "$__sd_token" "$1"; }
__sd_prompt() {
    if [[ -n ${__sd_run_keys-} ]]; then
        local map
        for map in emacs-standard vi-insert; do
            bind -m "$map" -r '\e[777~'
            bind -m "$map" -r '\e[778~'
            bind -m "$map" -r "$__sd_run_keys"
        done
        unset __sd_run_keys __sd_insert_key
    fi
    __sd_previous=$(__sd_hist)
    printf '\033]777;sd-ssh;%s;cwd;%s\007' "$__sd_token" "$(__sd_b64 "$PWD")"
    __sd_activity idle
}
__sd_submit() {
    local row line='' LC_ALL=C
    row=$(__sd_hist)
    if [[ -o history && -n $HISTFILE && $HISTFILE != /dev/null && ${HISTFILESIZE-} != 0 && $row != "$__sd_previous" &&
          $row =~ ^[[:blank:]]*[0-9]+[\*\ ][\ ](.*)$ ]]; then
        line=${BASH_REMATCH[1]}
        if (( ${#line} > 4096 )) || [[ $line == [[:blank:]]* || $line == *[[:cntrl:]]* ]]; then line=''; fi
    fi
    printf '\033]777;sd-ssh;%s;cmd;%s\007' "$__sd_token" "$(__sd_b64 "$line")"
}
if [[ '__RESTORE__' != no ]]; then
    __sd_tty=$(stty -g) && stty -echo -icanon min 1 time 0 || exit 1
    printf '\033]777;sd-read;%s\007' "$__sd_token"
    IFS= read -r __sd_dir && IFS= read -r __sd_cmd || { stty "$__sd_tty"; exit 1; }
    stty "$__sd_tty" || exit 1
    __sd_dir=$(printf '%s' "$__sd_dir" | command base64 -d) || exit 1
    __sd_line=$(printf '%s' "$__sd_cmd" | command base64 -d) || exit 1
    if ! builtin cd -- "$__sd_dir"; then
        builtin cd -- "$HOME" || exit 1
        __sd_line=''
    fi
    unset __sd_dir __sd_tty
    if [[ -n $__sd_cmd ]]; then
        # The client sends only a fixed editing key. The saved line stays data.
        __sd_insert() {
            if [[ -n ${__sd_line-} ]]; then
                READLINE_LINE=$__sd_line
                READLINE_POINT=${#READLINE_LINE}
                unset __sd_line
            fi
        }
        if [[ '__RESTORE__' == run && -n $__sd_line ]]; then
            __sd_insert_key='\e[779~'
            if (( __sd_bash_version < 404 )); then __sd_insert_key='\C-^'; fi
            __sd_insert_and_accept() {
                __sd_insert
                __sd_run_keys=$__sd_insert_key
            }
            for __sd_map in emacs-standard vi-insert; do
                bind -m "$__sd_map" -x "\"$__sd_insert_key\":__sd_insert_and_accept" &&
                    bind -m "$__sd_map" '"\e[778~":accept-line' &&
                    bind -m "$__sd_map" "\"\e[777~\":\"${__sd_insert_key}\e[778~\"" || exit 1
            done
        elif (( __sd_bash_version < 404 )); then
            # Older Readline cannot invoke bind -x on this multi-byte sequence.
            __sd_legacy_insert() {
                __sd_insert
                bind -r '\C-^'
                bind -r '\e[777~'
            }
            bind -x '"\C-^":__sd_legacy_insert' && bind '"\e[777~":"\C-^"' || exit 1
        else
            for __sd_map in emacs-standard vi-insert; do
                bind -m "$__sd_map" -x '"\e[777~":__sd_insert' || exit 1
            done
        fi
        if [[ -n $__sd_line ]]; then
            printf '\033]777;sd-ssh;%s;cmd;%s\007' "$__sd_token" "$(__sd_b64 "$__sd_line")"
        fi
    fi
    unset __sd_cmd
    printf '\033]777;sd-edit;%s\007' "$__sd_token"
fi

__sd_prompt_hook=__sd_prompt
if (( __sd_bash_version >= 404 )); then
    # PS0 expands after Readline accepts a command and before that command runs.
    PS0='$(__sd_activity running; __sd_submit)'${PS0-}
elif [[ -z $(trap -p DEBUG) ]]; then
    # DEBUG fires for prompt hooks as well. Arm the trap only between prompts
    # so it reports once per submission, with the history rules still in effect.
    __sd_prompt_begin() {
        local status=$?
        if [[ ${__sd_pending-} ]]; then
            __sd_pending=
            # Some constructs, including function definitions, emit no DEBUG
            # event. Read their history entry before the user's prompt hook.
            if [[ $(__sd_hist) != "$__sd_previous" ]]; then __sd_submit; fi
        fi
        return "$status"
    }
    __sd_prompt_end() {
        __sd_prompt
        __sd_pending=1
    }
    PROMPT_COMMAND="__sd_prompt_begin${PROMPT_COMMAND:+$'\n'$PROMPT_COMMAND}"
    __sd_prompt_hook=__sd_prompt_end
    trap 'if [[ ${__sd_pending-} && $BASH_SUBSHELL == 0 && -z ${FUNCNAME[0]-} &&
                $BASH_COMMAND != __sd_prompt_begin && $BASH_COMMAND != __sd_legacy_insert &&
                $BASH_COMMAND != __sd_insert_and_accept ]]; then
        __sd_pending=
        __sd_activity running
        __sd_submit
    fi' DEBUG
fi
if (( __sd_bash_version >= 501 )) &&
   [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
    PROMPT_COMMAND+=("$__sd_prompt_hook")
else
    PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND$'\n'}$__sd_prompt_hook"
fi
unset __sd_prompt_hook __sd_bash_version
