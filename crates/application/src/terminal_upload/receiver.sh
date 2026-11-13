sd_nonce=$1
sd_left=$2
sd_kind=$3
sd_name64=$4
sd_mtime=$5
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
unset TAR_OPTIONS
sd_stage=
sd_tty=
sd_code=STARTUP
sd_done=0
sd_success=0
sd_ready=0
sd_worker=
sd_received=0
sd_frame() { printf '\036SDU:%s:%s\037' "$sd_nonce" "$1"; }
sd_unsafe() {
  sd_frame "FAIL:STREAM:$sd_done"
  # A partial frame has no safe Shell boundary. Stay isolated until the client
  # closes this terminal; never interpret remaining binary bytes as Shell input.
  cat >/dev/null
  exit 1
}
sd_control() {
  sd_ctl=$(timeout --foreground 30 head -c 1) || sd_unsafe
  [ -n "$sd_ctl" ] || sd_unsafe
}
sd_fail() { sd_code=$1; exit 1; }
sd_finish() {
  trap - EXIT INT TERM HUP
  if [ -n "$sd_worker" ]; then
    kill -TERM "$sd_worker" 2>/dev/null
    wait "$sd_worker" 2>/dev/null
    sd_worker=
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
  elif [ "$sd_success" = 1 ]; then sd_frame "DONE:$sd_done"
  else sd_frame "ERROR:$sd_code:$sd_done"; fi
  if [ "$sd_ready" = 1 ]; then
    # Release follows all queued data/cancel bytes, before restoring the TTY.
    while :; do
      sd_control
      case "$sd_ctl" in R) break ;; C) : ;; *) sd_unsafe ;; esac
    done
  fi
  if [ -n "$sd_tty" ]; then
    stty "$sd_tty" || sd_frame "ERROR:TTY_RESTORE:$sd_done"
  fi
}
sd_wait_worker() {
  while kill -0 "$sd_worker" 2>/dev/null; do
    sd_ctl=$(timeout --foreground 0.1 head -c 1)
    sd_status=$?
    if [ "$sd_status" = 124 ] && [ -z "$sd_ctl" ]; then continue; fi
    [ "$sd_status" = 0 ] && [ "$sd_ctl" = C ] || sd_unsafe
    kill -TERM "$sd_worker" 2>/dev/null
    wait "$sd_worker" 2>/dev/null
    sd_worker=
    sd_fail CANCELLED
  done
  wait "$sd_worker"
  sd_status=$?
  sd_worker=
  return "$sd_status"
}
trap sd_finish EXIT
trap 'sd_code=CANCELLED; exit 1' INT TERM HUP
for sd_cmd in tar base64 stty head mktemp sha256sum mv rm timeout wc tee mkdir id cat; do
  command -v "$sd_cmd" >/dev/null 2>&1 || sd_fail DEPENDENCY
done
base64 --version >/dev/null 2>&1 || sd_fail DEPENDENCY
tar --version >/dev/null 2>&1 || sd_fail DEPENDENCY
tee -a /dev/null </dev/null >/dev/null || sd_fail DEPENDENCY
timeout --foreground 1 true || sd_fail DEPENDENCY
case "$sd_kind" in
  file)
    command -v chmod >/dev/null 2>&1 || sd_fail DEPENDENCY
    command -v touch >/dev/null 2>&1 || sd_fail DEPENDENCY
    case "$sd_mtime" in ''|*[!0-9]*) sd_fail STARTUP ;; esac
    sd_filename=$(printf '%s' "$sd_name64" | base64 -d) || sd_fail STARTUP
    case "$sd_filename" in ''|.|..|*/*) sd_fail STARTUP ;; esac ;;
  archive) : ;;
  *) sd_fail STARTUP ;;
esac
sd_tty=$(stty -g) || sd_fail TTY
sd_uid=$(id -u) || sd_fail IDENTITY
sd_user=$(id -un 2>/dev/null) || sd_user=
sd_user=$(printf '%s' "$sd_user" | base64 -w 0) || sd_fail IDENTITY
sd_path=$(pwd -P | base64 -w 0) || sd_fail DIRECTORY
sd_stage=$(mktemp -d ./.serverdeck-upload.XXXXXXXXXX) || sd_fail PERMISSION
mkdir "$sd_stage/payload" || sd_fail PERMISSION
: > "$sd_stage/archive" || sd_fail PERMISSION
stty raw -echo || sd_fail TTY
sd_ready=1
sd_frame "READY:$sd_uid:$sd_user:$sd_path"
sd_failure=
while :; do
  sd_control
  case "$sd_ctl" in
    C) sd_fail "${sd_failure:-CANCELLED}" ;;
    F)
      [ "$sd_left" = 0 ] && [ -z "$sd_failure" ] || sd_unsafe
      sd_hash=$(timeout --foreground 30 head -c 64) || sd_unsafe
      [ "${#sd_hash}" = 64 ] || sd_unsafe
      case "$sd_hash" in *[!0-9a-f]*) sd_unsafe ;; esac
      break ;;
    D)
      # Bash 4.2 read can prefetch 128 bytes from a raw TTY, stranding binary
      # payload in the Shell's buffer. Read the fixed-width header exactly.
      sd_n=$(timeout --foreground 30 head -c 7) || sd_unsafe
      [ "${#sd_n}" = 7 ] || sd_unsafe
      case "$sd_n" in *[!0-9]*) sd_unsafe ;; esac
      while [ "${sd_n#0}" != "$sd_n" ]; do sd_n=${sd_n#0}; done
      [ -n "$sd_n" ] && [ "$sd_n" -le 4194304 ] && [ "$sd_n" -le "$sd_left" ] || sd_unsafe
      if [ -z "$sd_failure" ]; then
        # GNU tee keeps its stdout open after a regular-file write failure,
        # including coreutils 8.22. Count the drained input to keep frame alignment.
        sd_got=$(timeout --foreground 30 head -c "$sd_n" | tee -a "$sd_stage/archive" 2>/dev/null | wc -c)
      else sd_got=$(timeout --foreground 30 head -c "$sd_n" | wc -c); fi
      [ "$sd_got" -eq "$sd_n" ] || sd_unsafe
      sd_left=$((sd_left - sd_n))
      sd_received=$((sd_received + sd_n))
      if [ -z "$sd_failure" ]; then
        sd_actual=$(wc -c < "$sd_stage/archive") || sd_actual=-1
        if [ "$sd_actual" -eq "$sd_received" ]; then sd_frame "ACK:$sd_received"
        else sd_failure=RECEIVE; sd_frame "FAIL:RECEIVE:$sd_done"; fi
      fi ;;
    *) sd_unsafe ;;
  esac
done
sd_frame VERIFYING
sha256sum "$sd_stage/archive" > "$sd_stage/hash" &
sd_worker=$!
sd_wait_worker || sd_fail CHECKSUM
IFS=' ' read -r sd_sum sd_rest < "$sd_stage/hash" || sd_fail CHECKSUM
[ "$sd_sum" = "$sd_hash" ] || sd_fail CHECKSUM
if [ "$sd_kind" = file ]; then
  # Restrict the staged file to 0644 or stricter, retaining the caller's umask.
  chmod go-w "$sd_stage/archive" || sd_fail EXTRACT
  touch -m -d "@$sd_mtime" -- "$sd_stage/archive" || sd_fail METADATA
  mv -T -- "$sd_stage/archive" "$sd_stage/payload/$sd_filename" || sd_fail EXTRACT
else
  tar --no-same-owner --no-same-permissions -xf "$sd_stage/archive" -C "$sd_stage/payload" &
  sd_worker=$!
  sd_wait_worker || sd_fail EXTRACT
fi
for sd_p in "$sd_stage"/payload/* "$sd_stage"/payload/.[!.]* "$sd_stage"/payload/..?*; do
  [ -e "$sd_p" ] || [ -L "$sd_p" ] || continue
  sd_name=${sd_p##*/}
  if [ -e "./$sd_name" ] || [ -L "./$sd_name" ]; then sd_fail CONFLICT; fi
done
sd_frame COMMIT_READY
sd_control
case "$sd_ctl" in C) sd_fail CANCELLED ;; K) : ;; *) sd_unsafe ;; esac
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
