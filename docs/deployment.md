# Deployment

**Target:** Any server (VPS, home server, cloud VM) with Node.js 20+ and systemd.

## Overview

Deploying Scrooge is a simple **git pull** workflow. Once the repo is cloned and secrets are in place, updating is just:

```bash
ssh <user>@<host>
cd scrooge
git pull
npm install
sudo systemctl restart scrooge-trader scrooge-strategist
```

The main thing you need to manage yourself is **secrets** — API keys go in `.env`, which should never be committed to git.

---

## Initial Server Setup

### 1. Clone the repo

```bash
ssh <user>@<host>
git clone <your-repo-url> scrooge
cd scrooge
npm install
```

### 2. Create secrets

```bash
cp .env.example .env
nano .env
# Fill in: ALPACA_API_KEY, ALPACA_SECRET_KEY, OPENROUTER_API_KEY
chmod 600 .env
```

### 3. Test

```bash
DRY_RUN=true npx tsx src/index.ts
```

### 4. Set up systemd services

Create service files so Scrooge runs as a daemon and restarts on failure.

**`/etc/systemd/system/scrooge-strategist.service`:**

```ini
[Unit]
Description=Scrooge Strategist - forms trading hypotheses
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<user>
WorkingDirectory=/home/<user>/scrooge
Environment="NODE_ENV=production"
EnvironmentFile=/home/<user>/scrooge/.env
ExecStart=/usr/bin/npx tsx strategist.ts
Restart=on-failure
RestartSec=30
StandardOutput=append:/home/<user>/scrooge/logs/strategist.log
StandardError=append:/home/<user>/scrooge/logs/strategist.log

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/scrooge-trader.service`:**

```ini
[Unit]
Description=Scrooge Trader - executes strategies
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<user>
WorkingDirectory=/home/<user>/scrooge
Environment="NODE_ENV=production"
EnvironmentFile=/home/<user>/scrooge/.env
ExecStart=/usr/bin/npx tsx trader.ts
Restart=on-failure
RestartSec=30
StandardOutput=append:/home/<user>/scrooge/logs/trader.log
StandardError=append:/home/<user>/scrooge/logs/trader.log

[Install]
WantedBy=multi-user.target
```

**Optional — Flask Dashboard API (`/etc/systemd/system/scrooge-api.service`):**

```ini
[Unit]
Description=Scrooge Dashboard API (Flask)
After=network.target

[Service]
Type=simple
User=<user>
WorkingDirectory=/home/<user>/scrooge
Environment=SCROOGE_STATE=/home/<user>/scrooge/data/state.json
Environment=SCROOGE_API_PORT=5000
Environment=SCROOGE_API_HOST=0.0.0.0
ExecStart=/home/<user>/.local/bin/gunicorn -b 0.0.0.0:5000 --workers 2 --log-file /home/<user>/scrooge/logs/api.log --error-logfile /home/<user>/scrooge/logs/api-error.log api.app:app
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable scrooge-strategist scrooge-trader
sudo systemctl start scrooge-strategist scrooge-trader
```

---

## Updating

```bash
ssh <user>@<host>
cd scrooge
git pull                     # fetch latest code
npm install                  # new/updated deps
sudo systemctl restart scrooge-trader scrooge-strategist
```

If the update changed the API code:

```bash
sudo systemctl restart scrooge-api
```

---

## Secrets Management

Never commit `.env` to git. It's already in `.gitignore`, but:

- **First time:** `cp .env.example .env` on the server, fill in real keys
- **Updates:** Edit `.env` directly on the server (`nano .env`), then restart services
- **Rotating keys:** Same process — edit `.env`, restart
- **Multiple servers:** Copy `.env` via `scp` or a password manager

Alternatively, use environment variables injected by your hosting platform (e.g., Railway, Fly.io, systemd `Environment=` lines) instead of a file-based `.env`.

---

## ⚠️ Data Source Convention

**The deployed server is the canonical data source for all runtime state** — positions, trades, lessons, strategies. The local development `data/` directory contains only test/fixture data.

When checking production state:

- **Preferred:** Flask API `http://<host>:5000/api/...`
- **Fallback:** `ssh <user>@<host> && cat data/state.json`

Do not rely on your local `data/state.json` for production answers.

---

## Systemd Control

```bash
sudo systemctl status scrooge-trader       # check if running
sudo systemctl restart scrooge-trader      # restart after config/code change
sudo systemctl stop scrooge-trader         # emergency stop
sudo journalctl -u scrooge-trader -f       # live logs
tail -f logs/trader.log                    # file logs
```

---

## Rollback

```bash
cd scrooge
git log --oneline -10
git checkout <previous-commit-hash>
sudo systemctl restart scrooge-trader scrooge-strategist
```