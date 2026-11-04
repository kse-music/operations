#!/bin/sh
set -eu
mkdir -p /run/serverdeck /run/sshd /home/plugin/nginx/logs /home/plugin/nginx/html
ssh-keygen -q -t ed25519 -N '' -f /run/serverdeck/ssh_host_ed25519_key
cat > /home/plugin/nginx/nginx.conf <<'CONFIG'
worker_processes 1;
pid /home/plugin/nginx/nginx.pid;
error_log /home/plugin/nginx/logs/error.log info;
events { worker_connections 64; }
http {
  access_log /home/plugin/nginx/logs/access.log;
  client_body_temp_path /home/plugin/nginx/client_temp;
  proxy_temp_path /home/plugin/nginx/proxy_temp;
  fastcgi_temp_path /home/plugin/nginx/fastcgi_temp;
  uwsgi_temp_path /home/plugin/nginx/uwsgi_temp;
  scgi_temp_path /home/plugin/nginx/scgi_temp;
  server { listen 8080; root /home/plugin/nginx/html; }
}
CONFIG
printf '%s\n' 'ServerDeck isolated plugin test host' > /home/plugin/nginx/html/index.html
chown -R plugin:plugin /home/plugin
su plugin -c 'nginx -p /home/plugin/nginx/ -c /home/plugin/nginx/nginx.conf'
exec /usr/sbin/sshd -D -e -f /etc/ssh/serverdeck_sshd_config
