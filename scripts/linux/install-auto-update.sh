#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root"
  exit 1
fi

ROOT_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
UPDATE_SCRIPT="$ROOT_DIR/scripts/linux/update.sh"

if [[ ! -x "$UPDATE_SCRIPT" ]]; then
  chmod 750 "$UPDATE_SCRIPT"
fi

cat >/etc/systemd/system/puff-auto-update.service <<EOF
[Unit]
Description=Puff QQ Bot automatic Git update
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
ExecStart=/usr/bin/flock -n /run/puff-auto-update.lock /usr/bin/bash $UPDATE_SCRIPT
TimeoutStartSec=15min
EOF

cat >/etc/systemd/system/puff-auto-update.timer <<'EOF'
[Unit]
Description=Check Puff QQ Bot updates every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30
Persistent=true
Unit=puff-auto-update.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now puff-auto-update.timer
systemctl list-timers puff-auto-update.timer --no-pager
