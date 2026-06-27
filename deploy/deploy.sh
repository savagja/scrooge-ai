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
    exit 1
fi

if ! grep -q "ALPACA_API_KEY" "$LOCAL_DIR/.env"; then
    echo "❌ .env exists but missing ALPACA_API_KEY"
    exit 1
fi

echo "   ✅ .env exists"

# ─── 2. Create tarball (exclude data, logs, node_modules, etc.) ──────
echo
echo "📦 Creating deploy tarball..."
TARBALL="/tmp/scrooge-deploy-$(date +%s).tar.gz"
tar czf "$TARBALL" \
    --exclude=node_modules \
    --exclude=data \
    --exclude=logs \
    --exclude=.git \
    --exclude=dist \
    --exclude=deploy \
    -C "$LOCAL_DIR" \
    .
echo "   ✅ Tarball created ($(du -h "$TARBALL" | cut -f1))"

# ─── 3. Deploy to Pi ─────────────────────────────
echo
echo "📤 Deploying to Pi (preserving data/ and logs/)..."

# Stop the bot service
ssh -i ~/.ssh/id_ed25519_pi "$REMOTE_HOST" 'sudo systemctl stop scrooge 2>/dev/null; sudo systemctl reset-failed scrooge 2>/dev/null; echo "bot stopped"'

# Push code — remove everything except data/ and logs/
ssh -i ~/.ssh/id_ed25519_pi "$REMOTE_HOST" \
    "cd $REMOTE_DIR && find . -maxdepth 1 ! -name '.' ! -name 'data' ! -name 'logs' -exec rm -rf {} + 2>/dev/null; echo 'cleaned (preserved data/ and logs/)'"

# Extract new code
cat "$TARBALL" | ssh -i ~/.ssh/id_ed25519_pi "$REMOTE_HOST" "cd $REMOTE_DIR && tar xzf - && echo 'code extracted'"

# Clean up local tarball
rm -f "$TARBALL"

# ─── 4. Remote setup ────────────────────────────
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

    echo "   ⚙️  Ensuring systemd service..."
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

# ─── 5. Deploy report ─────────────────────────────
echo
echo "═══════════════════════════════════════════════════════"
echo "  ✅ DEPLOYED to admin@192.168.50.42:/home/admin/scrooge"
echo "═══════════════════════════════════════════════════════"
echo
echo "Next steps:"
echo
echo "  1. Start the bot:"
echo "     ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'sudo systemctl start scrooge'"
echo
echo "  2. Watch logs:"
echo "     ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'sudo journalctl -u scrooge -f'"
echo
echo "═══════════════════════════════════════════════════════"
