#!/usr/bin/env bash
# One-time setup of SEC Transmission WMS on a Hostinger VPS (Ubuntu 22.04 / 24.04).
# Run as root:
#   REPO_URL=git@github.com:OWNER/REPO.git DOMAIN=wms.example.com EMAIL=you@example.com bash setup-vps.sh
set -euo pipefail

REPO_URL="${REPO_URL:?Set REPO_URL, e.g. git@github.com:OWNER/REPO.git}"
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
BRANCH="${BRANCH:-main}"
APP_USER=wms
APP_DIR=/opt/sec-wms
DATA_DIR=/var/lib/sec-wms

echo "==> System packages"
apt-get update -y
apt-get install -y curl git nginx ufw ca-certificates gnupg
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v
npm install -g pm2

echo "==> App user and folders"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

echo "==> GitHub access (deploy key)"
sudo -u "$APP_USER" bash -c 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && [ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C "hostinger-vps-deploy"; ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null'
if [[ "$REPO_URL" == git@* ]]; then
  echo
  echo "Add this key in GitHub → repository → Settings → Deploy keys (read-only):"
  cat "/home/$APP_USER/.ssh/id_ed25519.pub"
  read -r -p "Press Enter after adding the deploy key..."
fi

echo "==> Code"
if [ ! -d "$APP_DIR/.git" ]; then
  sudo -u "$APP_USER" git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
fi
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env
  ADMIN_PW="$(openssl rand -base64 12)"
  sed -i "s|^DATA_DIR=.*|DATA_DIR=$DATA_DIR|; s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$ADMIN_PW|" .env
  [ -n "$DOMAIN" ] && sed -i "s|^APP_URL=.*|APP_URL=https://$DOMAIN|" .env
  chown "$APP_USER:$APP_USER" .env && chmod 600 .env
  echo "Created .env - administrator: admin / $ADMIN_PW  (store it safely, then change it after first login)"
  echo "Edit SMTP settings in $APP_DIR/.env to enable email."
fi
sudo -u "$APP_USER" mkdir -p logs

echo "==> Start with PM2"
sudo -u "$APP_USER" pm2 start ecosystem.config.cjs || sudo -u "$APP_USER" pm2 reload ecosystem.config.cjs
sudo -u "$APP_USER" pm2 save
env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null

echo "==> Nginx"
cp deploy/nginx-sec-wms.conf /etc/nginx/sites-available/sec-wms
[ -n "$DOMAIN" ] && sed -i "s/wms.example.com/$DOMAIN/g" /etc/nginx/sites-available/sec-wms
ln -sf /etc/nginx/sites-available/sec-wms /etc/nginx/sites-enabled/sec-wms
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> Firewall"
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable

if [ -n "$DOMAIN" ] && [ -n "$EMAIL" ]; then
  echo "==> HTTPS certificate"
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive --redirect
fi

echo "==> Daily backup at 02:30"
CRON="30 2 * * * cd $APP_DIR && npm run backup >> logs/backup.log 2>&1 && tar -czf $DATA_DIR/backups/uploads-\$(date +\%Y\%m\%d).tgz -C $DATA_DIR uploads 2>/dev/null; find $DATA_DIR/backups -name 'uploads-*.tgz' -mtime +14 -delete"
( sudo -u "$APP_USER" crontab -l 2>/dev/null | grep -v 'npm run backup'; echo "$CRON" ) | sudo -u "$APP_USER" crontab -

echo
echo "Done. Open: ${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://<server-ip>}  -  health: /healthz"
