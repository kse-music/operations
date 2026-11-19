#!/usr/bin/env bash
set -euo pipefail

# Bypass the runner's Azure mirror, which can stall while fetching package indexes.
sources=$(mktemp)
trap 'rm -f -- "$sources"' EXIT
cat > "$sources" <<'EOF'
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu jammy main restricted universe multiverse
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu jammy-updates main restricted universe multiverse
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu jammy-backports main restricted universe multiverse
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu jammy-security main restricted universe multiverse
EOF

apt_options=(
  -o "Dir::Etc::sourcelist=$sources"
  -o Dir::Etc::sourceparts=-
  -o Acquire::Retries=1
  -o Acquire::https::Timeout=15
  -o Acquire::Languages=none
  -o Acquire::IndexTargets::deb::DEP-11::DefaultEnabled=false
)

sudo apt-get "${apt_options[@]}" --no-list-cleanup --error-on=any update
sudo apt-get "${apt_options[@]}" install -y \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libssl-dev libdbus-1-dev patchelf "$@"
