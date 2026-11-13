sd_nonce=$1
sd_left=$2
sd_hash=$3
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
unset TAR_OPTIONS
sd_stage=
sd_tty=
sd_code=STARTUP
sd_done=0
sd_success=0
sd_ready=0
sd_frame() { printf '\036SDU:%s:%s\037' "$sd_nonce" "$1"; }
sd_fail() {
  sd_code=$1
  if [ "$sd_ready" = 1 ]; then
    sd_frame "FAIL:$sd_code:$sd_done"
    # Never return queued payload to the interactive Shell. The sender first
    # drops its unsent queue, then sends SIGINT in-order to flush the PTY.
    cat >/dev/null
  fi
  exit 1
}
sd_finish() {
  trap - EXIT INT TERM HUP
  if [ -n "$sd_tty" ]; then
    stty "$sd_tty" || sd_code=TTY_RESTORE
  fi
  if [ -n "$sd_stage" ]; then
    case "$sd_stage" in
      ./.serverdeck-upload.*)
        if [ -d "$sd_stage" ] && [ ! -L "$sd_stage" ]; then
          rm -rf -- "$sd_stage" || sd_code=CLEANUP
        else sd_code=CLEANUP; fi ;;
      *) sd_code=CLEANUP ;;
    esac
  fi
  if [ "$sd_code" = CLEANUP ]; then
    sd_recovery=$(printf '%s' "$sd_stage" | base64 -w 0)
    sd_frame "ERROR:CLEANUP:$sd_done:$sd_recovery"
  elif [ "$sd_success" = 1 ] && [ "$sd_code" != TTY_RESTORE ]; then
    sd_frame "DONE:$sd_done"
  else sd_frame "ERROR:$sd_code:$sd_done"; fi
}
trap sd_finish EXIT
trap 'sd_code=CANCELLED; exit 1' INT TERM HUP
for sd_cmd in tar base64 stty head mktemp sha256sum mv rm timeout wc mkdir id cat; do
  command -v "$sd_cmd" >/dev/null 2>&1 || sd_fail DEPENDENCY
done
base64 --version >/dev/null 2>&1 || sd_fail DEPENDENCY
tar --version >/dev/null 2>&1 || sd_fail DEPENDENCY
timeout --foreground 1 true || sd_fail DEPENDENCY
sd_tty=$(stty -g) || sd_fail TTY
sd_uid=$(id -u) || sd_fail IDENTITY
sd_user=$(id -un 2>/dev/null) || sd_user=
sd_user=$(printf '%s' "$sd_user" | base64 -w 0) || sd_fail IDENTITY
sd_path=$(pwd -P | base64 -w 0) || sd_fail DIRECTORY
sd_stage=$(mktemp -d ./.serverdeck-upload.XXXXXXXXXX) || sd_fail PERMISSION
mkdir "$sd_stage/payload" || sd_fail PERMISSION
stty -echo -icanon -iexten -ixon -ixoff -icrnl -inlcr -igncr isig min 1 time 0 || sd_fail TTY
sd_ready=1
sd_frame "READY:$sd_uid:$sd_user:$sd_path"
sd_seq=0
while [ "$sd_left" -gt 0 ]; do
  sd_n=65536
  [ "$sd_left" -ge "$sd_n" ] || sd_n=$sd_left
  sd_encoded=$(( (sd_n + 2) / 3 * 4 ))
  timeout --foreground 30 head -c "$sd_encoded" > "$sd_stage/chunk" || sd_fail RECEIVE
  [ "$(wc -c < "$sd_stage/chunk")" -eq "$sd_encoded" ] || sd_fail RECEIVE
  base64 --decode "$sd_stage/chunk" >> "$sd_stage/archive" || sd_fail DECODE
  sd_left=$((sd_left - sd_n))
  sd_frame "ACK:$sd_seq"
  sd_seq=$((sd_seq + 1))
done
sd_frame VERIFYING
sd_sum=$(sha256sum "$sd_stage/archive") || sd_fail CHECKSUM
[ "${sd_sum%% *}" = "$sd_hash" ] || sd_fail CHECKSUM
tar --no-same-owner --no-same-permissions -xf "$sd_stage/archive" -C "$sd_stage/payload" || sd_fail EXTRACT
for sd_p in "$sd_stage"/payload/* "$sd_stage"/payload/.[!.]* "$sd_stage"/payload/..?*; do
  [ -e "$sd_p" ] || [ -L "$sd_p" ] || continue
  sd_name=${sd_p##*/}
  if [ -e "./$sd_name" ] || [ -L "./$sd_name" ]; then sd_fail CONFLICT; fi
done
sd_frame COMMITTING
for sd_p in "$sd_stage"/payload/* "$sd_stage"/payload/.[!.]* "$sd_stage"/payload/..?*; do
  [ -e "$sd_p" ] || [ -L "$sd_p" ] || continue
  sd_name=${sd_p##*/}
  mv -T -n -- "$sd_p" "./$sd_name" || sd_fail COMMIT
  if [ -e "$sd_p" ] || [ -L "$sd_p" ]; then sd_fail CONFLICT; fi
  sd_done=$((sd_done + 1))
done
sd_success=1
exit 0
