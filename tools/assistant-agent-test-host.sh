#!/bin/bash
# A separate Docker daemon owns every image visible to the disposable SSH host.
set -euo pipefail
mode=${1:?}
run_id=${2:?}
[[ "$run_id" =~ ^[a-f0-9-]{36}$ ]] || exit 64
run_root="/tmp/serverdeck-agent-$run_id"
host_docker() { docker --host unix:///var/run/docker.sock "$@"; }
owned_docker() { docker --host "unix://$run_root/docker.sock" "$@"; }
if [[ "$mode" == start ]]; then
  [[ ! -e "$run_root" ]] || exit 65
  mkdir -m 700 "$run_root"
  printf '%s' "$run_id" > "$run_root/owner"
  printf '{}' > "$run_root/daemon.json"
  IFS= read -r task_password
  nohup unshare --net -- dockerd --config-file "$run_root/daemon.json" --host "unix://$run_root/docker.sock" --data-root "$run_root/data" --exec-root "$run_root/exec" --pidfile "$run_root/dockerd.pid" --storage-driver vfs --bridge none --iptables=false --ip6tables=false --ip-forward=false --ip-masq=false > "$run_root/dockerd.log" 2>&1 < /dev/null &
  ready=false
  for _ in {1..100}; do if owned_docker info > /dev/null 2>&1; then ready=true; break; fi; sleep .1; done
  [[ "$ready" == true ]] || { tail -30 "$run_root/dockerd.log" >&2; exit 66; }
  [[ "$(owned_docker info --format '{{.DockerRootDir}}')" == "$run_root/data" ]] || exit 67
  chmod 666 "$run_root/docker.sock"
  for number in 1 2; do
    tar -cf - --files-from /dev/null | owned_docker image import --change "ENV SERVERDECK_FIXTURE=$run_id-$number" - > /dev/null
  done
  tar -cf - --files-from /dev/null | owned_docker image import --change "ENV SERVERDECK_FIXTURE=$run_id-keep" - "serverdeck-agent-keep:$run_id" > /dev/null
  host_id=$(host_docker run --detach --cidfile "$run_root/host.id" --name "serverdeck-agent-$run_id" --label "cn.hiboot.qa.assistant-agent=$run_id" --memory 256m --cpus 1 --pids-limit 128 --security-opt no-new-privileges --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add AUDIT_WRITE --cap-add SETUID --cap-add SETGID --cap-add SYS_CHROOT --cap-add NET_BIND_SERVICE --cap-add DAC_OVERRIDE --tmpfs /run:rw,nosuid,nodev,mode=755 --tmpfs /home/plugin:rw,nodev,mode=755 --mount "type=bind,source=$run_root/docker.sock,target=/var/run/docker.sock" --publish 127.0.0.1::22 serverdeck-plugin13a-test:13a)
  printf '%s' "$host_id" > "$run_root/host.id"
  host_docker cp /usr/bin/docker "$host_id:/usr/local/bin/docker" > /dev/null
  printf 'plugin:%s\n' "$task_password" | host_docker exec --interactive "$host_id" chpasswd
  unset task_password
  ready=false
  for _ in {1..100}; do if host_docker exec "$host_id" test -f /run/serverdeck/ssh_host_ed25519_key.pub; then ready=true; break; fi; sleep .1; done
  [[ "$ready" == true ]] || exit 68
  port=$(host_docker port "$host_id" 22/tcp)
  key=$(host_docker exec "$host_id" cat /run/serverdeck/ssh_host_ed25519_key.pub)
  images=$(owned_docker image ls --all --no-trunc --format '{{json .}}')
  python3 -c 'import json,sys; print(json.dumps({"port":int(sys.argv[1].rsplit(":",1)[1]),"hostKey":sys.argv[2],"images":[json.loads(line) for line in sys.argv[3].splitlines()]}))' "$port" "$key" "$images"
elif [[ "$mode" == inspect ]]; then
  [[ ! -L "$run_root" && "$(realpath "$run_root")" == "$run_root" && "$(cat "$run_root/owner")" == "$run_id" ]] || exit 69
  [[ "$(owned_docker info --format '{{.DockerRootDir}}')" == "$run_root/data" ]] || exit 70
  owned_docker image ls --all --no-trunc --format '{{json .}}'
elif [[ "$mode" == logs ]]; then
  [[ ! -L "$run_root" && "$(realpath "$run_root")" == "$run_root" && "$(cat "$run_root/owner")" == "$run_id" ]] || exit 69
  host_id=$(cat "$run_root/host.id")
  [[ "$(host_docker inspect --format '{{index .Config.Labels "cn.hiboot.qa.assistant-agent"}}|{{.Name}}' "$host_id")" == "$run_id|/serverdeck-agent-$run_id" ]] || exit 71
  host_docker logs --tail 30 "$host_id" 2>&1
elif [[ "$mode" == stop ]]; then
  [[ -d "$run_root" ]] || exit 0
  [[ ! -L "$run_root" && "$(realpath "$run_root")" == "$run_root" && "$(cat "$run_root/owner")" == "$run_id" ]] || exit 69
  if [[ -f "$run_root/host.id" ]]; then
    host_id=$(cat "$run_root/host.id")
    [[ "$(host_docker inspect --format '{{index .Config.Labels "cn.hiboot.qa.assistant-agent"}}|{{.Name}}' "$host_id")" == "$run_id|/serverdeck-agent-$run_id" ]] || exit 71
    host_docker rm --force "$host_id" > /dev/null
  fi
  if [[ -f "$run_root/dockerd.pid" ]]; then
    daemon_pid=$(cat "$run_root/dockerd.pid")
    [[ "$daemon_pid" =~ ^[0-9]+$ ]] || exit 72
    if [[ -e "/proc/$daemon_pid/cmdline" ]]; then
      tr '\0' '\n' < "/proc/$daemon_pid/cmdline" | grep -Fx -- "$run_root/data" > /dev/null || exit 73
      kill -TERM "$daemon_pid"
      for _ in {1..100}; do if ! kill -0 "$daemon_pid" 2>/dev/null; then break; fi; sleep .1; done
      ! kill -0 "$daemon_pid" 2>/dev/null || exit 74
    fi
  fi
  # rm does not follow links; the exact absolute task root and owner were checked above.
  rm -rf -- "$run_root"
else
  exit 64
fi
