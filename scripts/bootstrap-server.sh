#!/usr/bin/env bash
# One-time server bootstrap on Ubuntu — run as root or with sudo.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<USER>/<REPO>/main/scripts/bootstrap-server.sh | sudo bash -s <USER>/<REPO> <DOMAIN> <ZHIPUAI_API_KEY>
# Or scp this file over and run:
#   sudo bash bootstrap-server.sh <USER>/<REPO> <DOMAIN> <ZHIPUAI_API_KEY>

set -euo pipefail

REPO="${1:?Usage: bootstrap-server.sh <github-user>/<repo> <domain> <zhipuai-key>}"
DOMAIN="${2:?missing domain}"
ZHIPUAI_KEY="${3:?missing zhipuai api key}"

APP_DIR=/opt/xiaoer
APP_USER=xiaoer

echo "==> Install Docker + git"
apt-get update -y
apt-get install -y ca-certificates curl gnupg git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "==> Create deploy user '$APP_USER'"
id -u "$APP_USER" &>/dev/null || useradd -m -s /bin/bash "$APP_USER"
usermod -aG docker "$APP_USER"

echo "==> Clone repo into $APP_DIR"
mkdir -p "$APP_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" git clone "https://github.com/${REPO}.git" "$APP_DIR" 2>/dev/null \
  || (cd "$APP_DIR" && sudo -u "$APP_USER" git pull)

echo "==> Write .env and Caddyfile"
cat > "$APP_DIR/.env" <<EOF
ZHIPUAI_API_KEY=$ZHIPUAI_KEY
DOMAIN=$DOMAIN
EOF
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

cat > "$APP_DIR/Caddyfile" <<EOF
$DOMAIN {
    reverse_proxy xiaoer:8765
}
EOF
chown "$APP_USER:$APP_USER" "$APP_DIR/Caddyfile"

echo "==> Generate deploy SSH key for github actions"
KEY_FILE=/home/$APP_USER/.ssh/deploy_ed25519
sudo -u "$APP_USER" mkdir -p /home/$APP_USER/.ssh
chmod 700 /home/$APP_USER/.ssh
if [ ! -f "$KEY_FILE" ]; then
  sudo -u "$APP_USER" ssh-keygen -t ed25519 -N '' -f "$KEY_FILE" -C "github-actions"
  cat "$KEY_FILE.pub" >> /home/$APP_USER/.ssh/authorized_keys
  chown "$APP_USER:$APP_USER" /home/$APP_USER/.ssh/authorized_keys
  chmod 600 /home/$APP_USER/.ssh/authorized_keys
fi

echo "==> First deploy"
cd "$APP_DIR"
sudo -u "$APP_USER" docker compose -f docker-compose.prod.yml --env-file .env up -d --build

echo
echo "════════════════════════════════════════════════════════════════"
echo "✅ Done. Site should be live at: https://$DOMAIN"
echo
echo "GITHUB ACTIONS NEEDS THESE SECRETS (Settings → Secrets → Actions):"
echo "  SSH_HOST = $(curl -s ifconfig.me 2>/dev/null || echo '<your-server-ip>')"
echo "  SSH_USER = $APP_USER"
echo "  SSH_PRIVATE_KEY = (paste the entire content below)"
echo "──────── COPY EVERYTHING BETWEEN THE LINES ────────"
cat "$KEY_FILE"
echo "────────────────────────────────────────────────────"
echo
