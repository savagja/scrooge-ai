#!/bin/bash
set -e

echo "=== Scrooge Pi Deploy ==="
echo "Using Dobby Pi connection: admin@192.168.50.42"
echo

LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_HOST="admin@192.168.50.42"
REMOTE_DIR="/home/admin/scrooge"

# -- 1. Validate local setup --
echo "Validating local setup..."

if [ ! -f "$LOCAL_DIR/.env" ]; then
    echo "  .env not found. cp .env.example .env"
    exit 1
fi

if ! grep -q "ALPACA_API_KEY" "$LOCAL_DIR/.env"; then
    echo "  .env exists but missing ALPACA_API_KEY"
    exit 1
fi

echo "   .env exists"

# -- 2. Create tarball --
echo
echo "Creating deploy tarball..."
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
echo "   Tarball created ($(du -h "$TARBALL" | cut -f1))"

# -- 3. Deploy to Pi --
echo
echo "Deploying to Pi (preserving data/ and logs/)..."

# Stop old services
ssh -i ~/.ssh/id_ed25519_pi "$REMOTE_HOST" 'sudo systemctl stop scrooge-strategist scrooge-trader 2>/dev/null; sudo systemctl reset-failed scrooge-strategist scrooge-trader 2>/dev/null; echo "services stopped"'

# Push code
ssh -i ~/.ssh/id_ed25519_pi "$REMOTE_HOST" \
    "cd $REMOTE_DIR && find . -maxdepth 1 ! -name '.' ! -name 'data' ! -name 'logs' -exec rm -rf {} + 2>/dev/null; echo 'cleaned (preserved data/ and logs/)'"

# Extract new code
cat "$TARBALL" | ssh -i ~/.ssh/id_ed25519_pi "$REMOTE_HOST" "cd $REMOTE_DIR && tar xzf - && echo 'code extracted'"

# Clean up local tarball
rm -f "$TARBALL"

# -- 4. Remote setup --
echo
echo "Running remote setup..."

ssh -i ~/.ssh/id_ed25519_pi "$REMOTE_HOST" << 'REMOTE'
    set -e
    cd /home/admin/scrooge

    echo "   Installing dependencies..."
    npm install --omit=dev 2>&1 | tail -3

    echo "   Ensuring data dirs..."
    mkdir -p data logs

    echo "   Chmod .env..."
    chmod 600 .env 2>/dev/null || true

    echo "   Installing strategist systemd service..."
    sudo tee /etc/systemd/system/scrooge-strategist.service > /dev/null << 'SERVICEEOF'
[Unit]
Description=Scrooge Strategist - forms trading hypotheses
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=admin
WorkingDirectory=/home/admin/scrooge
Environment="NODE_ENV=production"
EnvironmentFile=/home/admin/scrooge/.env
ExecStart=/usr/bin/npx tsx strategist.ts
Restart=on-failure
RestartSec=30
StartLimitInterval=300
StartLimitBurst=5
StandardOutput=append:/home/admin/scrooge/logs/strategist.log
StandardError=append:/home/admin/scrooge/logs/strategist.log

[Install]
WantedBy=multi-user.target
SERVICEEOF

    echo "   Installing trader systemd service..."
    sudo tee /etc/systemd/system/scrooge-trader.service > /dev/null << 'SERVICEEOF'
[Unit]
Description=Scrooge Trader - executes strategies
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=admin
WorkingDirectory=/home/admin/scrooge
Environment="NODE_ENV=production"
EnvironmentFile=/home/admin/scrooge/.env
ExecStart=/usr/bin/npx tsx trader.ts
Restart=on-failure
RestartSec=30
StartLimitInterval=300
StartLimitBurst=5
StandardOutput=append:/home/admin/scrooge/logs/trader.log
StandardError=append:/home/admin/scrooge/logs/trader.log

[Install]
WantedBy=multi-user.target
SERVICEEOF

    # Remove old single service
    sudo systemctl disable scrooge.service 2>/dev/null || true
    sudo rm -f /etc/systemd/system/scrooge.service

    sudo systemctl daemon-reload
    sudo systemctl enable scrooge-strategist.service
    sudo systemctl enable scrooge-trader.service

    echo
    echo "   Setup complete. Services are ENABLED but NOT started."
REMOTE

# -- 5. Deploy report --
echo
echo "=========================================="
echo "  DEPLOYED to admin@192.168.50.42"
echo "=========================================="
echo
echo "Start both:"
echo "  ssh -i ~/.ssh/id_ed25519_pi $REMOTE_HOST \\"
echo "    'sudo systemctl start scrooge-strategist scrooge-trader'"
echo
echo "View logs:"
echo "  Strategist: sudo journalctl -u scrooge-strategist -f"
echo "  Trader:     sudo journalctl -u scrooge-trader -f"
echo
echo "Stop:"
echo "  ssh ... 'sudo systemctl stop scrooge-strategist scrooge-trader'"
echo
echo "Check status:"
echo "  ssh ... 'sudo systemctl status scrooge-strategist scrooge-trader'"
echo "=========================================="