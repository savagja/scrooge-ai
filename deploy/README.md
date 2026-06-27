# Raspberry Pi Deployment

Targets the **Dobby Pi** at `192.168.50.42` (user: `admin`).

## Prerequisites

- Pi online and reachable
- Your `.env` file filled in (`cp .env.example .env`)
- Dobby repo exists at `../dobby/pi/` (for Python deploy) OR you have `rsync` + `ssh` (for bash deploy)

## Quick Deploy

### Option A: Python (uses Dobby's paramiko helper)

```bash
cd scrooge
python deploy/deploy.py
```

### Option B: Bash (no Python dep)

```bash
cd scrooge
chmod +x deploy/deploy.sh
./deploy/deploy.sh
```

## First Run on Pi

```bash
ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42

cd /home/admin/scrooge

# 1. Test (recommended)
DRY_RUN=true npx tsx src/index.ts

# 2. Start daemon
sudo systemctl start scrooge

# 3. Watch
sudo journalctl -u scrooge -f
```

## Control Commands

| Action | Command |
|--------|---------|
| Start | `sudo systemctl start scrooge` |
| Stop | `sudo systemctl stop scrooge` |
| Restart | `sudo systemctl restart scrooge` |
| Status | `sudo systemctl status scrooge` |
| Logs | `sudo journalctl -u scrooge -f` |
| File logs | `tail -f /home/admin/scrooge/logs/scrooge.log` |

## Update Config on Pi

```bash
ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'nano /home/admin/scrooge/config.yaml'
ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'sudo systemctl restart scrooge'
```

Config changes auto-reload ~every 10 minutes even without restart.

## Re-deploy After Code Changes

Just re-run the deploy script. It rsyncs new code and restarts the service if it's running:

```bash
cd scrooge
python deploy/deploy.py && ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'sudo systemctl restart scrooge'
```

## Backup State Data

```bash
# Pull trade history + learning data from Pi
scp -i ~/.ssh/id_ed25519_pi \
    admin@192.168.50.42:/home/admin/scrooge/data/state.json \
    ./backup-$(date +%F).json
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `npm not found` | `sudo apt install nodejs npm` on Pi |
| `tsx not found` | `cd /home/admin/scrooge && npm install` |
| Bot crashes on start | Check `.env` has all 3 keys filled in |
| Alpaca NaN | Weekend/off-hours settledCash quirk, patched — ignore |
| Service won't start | `sudo journalctl -u scrooge --no-pager -n 50` |
