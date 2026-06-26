#!/bin/bash
set -e

echo "═══ Scrooge Pi Deploy ═══"
echo "Using Dobby Pi connection: admin@192.168.50.42"
echo

LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_HOST="admin@192.168.50.42"
REMOTE_DIR="/home/admin/scrooge"

# ─── 1. Validate local setup ───────────────────
echo "🔍 Validating local setup..."

if [ ! -f "$LOCAL_DIR/.env" ]; then
    echo "❌ .env not found."
    echo "   cp .env.example .env"
    echo "   # Then fill in ALPACA_API_KEY, ALPACA_SECRET_KEY, OPENROUTER_API_KEY"
    exit 1
fi

if ! grep -q "ALPACA_API_KEY" "$LOCAL_DIR/.env"; then
    echo "❌ .env exists but missing ALPACA_API_KEY"
    exit 1
fi

echo "   ✅ .env exists"

# ─── 2. Rsync to Pi ─────────────────────────────
echo
echo "📤 Syncing code to Pi..."
rsync -avz --delete \
    -e "ssh -i ~/.ssh/id_ed25519_pi -o StrictHostKeyChecking=accept-new" \
    --exclude 'node_modules' \
    --exclude 'data' \
    --exclude 'logs' \
    --exclude '.git' \
    --exclude 'dist' \
    --exclude 'deploy/' \
    "$LOCAL_DIR/" \
    "$REMOTE_HOST:$REMOTE_DIR/"

echo "   ✅ Code synced"

# ─── 3. Remote setup ────────────────────────────
echo
echo "🔧 Running remote setup..."

ssh -i ~/.ssh/id_ed25519_pi "$REMOTE_HOST" << 'REMOTE'
    set -e
    cd /home/admin/scrooge

    echo "   📦 Installing dependencies..."
    npm install --omit=dev 2>&1 | tail -3

    echo "   📂 Ensuring data dirs..."
    mkdir -p data logs

    echo "   🔒 Chmod .env..."
    chmod 600 .env 2>/dev/null || true

    echo "   ⚙️  Installing systemd service..."
    sudo tee /etc/systemd/system/scrooge.service > /dev/null << 'EOF'
[Unit]
Description=Scrooge AI Trading Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=admin
WorkingDirectory=/home/admin/scrooge
Environment="NODE_ENV=production"
EnvironmentFile=/home/admin/scrooge/.env
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=on-failure
RestartSec=30
StartLimitInterval=300
StartLimitBurst=5
StandardOutput=append:/home/admin/scrooge/logs/scrooge.log
StandardError=append:/home/admin/scrooge/logs/scrooge.log

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable scrooge.service

    echo
    echo "   ✅ Setup complete. Service is ENABLED but NOT started."
REMOTE

# ─── 4. Deploy report ─────────────────────────────
echo
echo "═══════════════════════════════════════════════════════"
echo "  ✅ DEPLOYED to admin@192.168.50.42:/home/admin/scrooge"
echo "═══════════════════════════════════════════════════════"
echo
echo "Next steps:"
echo
echo "  1. Test dry run (recommended):"
echo "     ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42"
echo "     cd /home/admin/scrooge"
echo "     DRY_RUN=true npx tsx src/index.ts"
echo
echo "  2. Start for real (paper trading):"
echo "     ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'sudo systemctl start scrooge'"
echo
echo "  3. Watch logs:"
echo "     ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'sudo journalctl -u scrooge -f'"
echo
echo "  4. Stop anytime:"
echo "     ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'sudo systemctl stop scrooge'"
echo
echo "  5. Edit config:"
echo "     ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'nano /home/admin/scrooge/config.yaml'"
echo "     # Then: ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'sudo systemctl restart scrooge'"
echo
echo "═══════════════════════════════════════════════════════"
