#!/bin/sh
set -eu
mkdir -p /run/serverdeck /run/sshd /home/plugin
ssh-keygen -q -t ed25519 -N '' -f /run/serverdeck/ssh_host_ed25519_key
chown plugin:plugin /home/plugin
exec /usr/sbin/sshd -D -e -f /etc/ssh/serverdeck_sshd_config
