# Loaded only for an interactive Bash PTY. Profile files belong to the user.
if [[ -r /etc/profile ]]; then . /etc/profile; fi
for __sd_profile in ~/.bash_profile ~/.bash_login ~/.profile; do
    if [[ -r $__sd_profile ]]; then . "$__sd_profile"; break; fi
done
unset __sd_profile
__sd_token='__TOKEN__'
__sd_b64() { printf '%s' "$1" | command base64 | tr -d '\r\n'; }
__sd_hist() { HISTTIMEFORMAT= builtin history 1; }
__sd_previous=$(__sd_hist)
__sd_prompt() {
    __sd_previous=$(__sd_hist)
    printf '\033]777;sd-ssh;%s;cwd;%s\007' "$__sd_token" "$(__sd_b64 "$PWD")"
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
# PS0 expands after Readline accepts a command and before that command runs.
PS0='$(__sd_submit)'${PS0-}
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
    PROMPT_COMMAND+=(__sd_prompt)
else
    PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND$'\n'}__sd_prompt"
fi
if [[ '__RESTORE__' == yes ]]; then
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
    unset __sd_cmd __sd_dir __sd_tty
    # The client sends only this fixed editing key. The saved line is data,
    # never a Readline macro, evaluated shell source or an Enter keystroke.
    __sd_insert() { READLINE_LINE=$__sd_line; READLINE_POINT=${#READLINE_LINE}; unset __sd_line; }
    for __sd_map in emacs-standard vi-insert; do
        bind -m "$__sd_map" -x '"\e[777~":__sd_insert' || exit 1
    done
    if [[ -n $__sd_line ]]; then
        printf '\033]777;sd-ssh;%s;cmd;%s\007' "$__sd_token" "$(__sd_b64 "$__sd_line")"
    fi
    printf '\033]777;sd-edit;%s\007' "$__sd_token"
fi
