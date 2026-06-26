# Pi Deploy Checklist

## Pre-Deploy (Local)

- [ ] `cp .env.example .env`
- [ ] Fill in `.env`: `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `OPENROUTER_API_KEY`
- [ ] Set `ALPACA_PAPER=true` (safety)
- [ ] Review `config.yaml` — verify watchlist, risk params
- [ ] Confirm: `Dobby` repo exists at `../dobby/pi/` (for Python deploy)

## Deploy

```bash
cd scrooge

# Option A: Python (preferred, uses Dobby's paramiko helper)
python deploy/deploy.py

# Option B: Bash (if Python unavailable)
chmod +x deploy/deploy.sh
./deploy/deploy.sh
```

## Post-Deploy (On Pi)

```bash
ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42
cd /home/admin/scrooge

# Test
timeout 60 DRY_RUN=true npx tsx src/index.ts 2>&1 | tail -20

# Start daemon if test looks good
sudo systemctl start scrooge

# Watch
sudo journalctl -u scrooge -f
```

## Monday Market Open

1. **9:00 AM ET** — Start bot: `sudo systemctl start scrooge`
2. **9:30–10:30** — Watch first cycle closely
3. **Midday** — Check `data/state.json` for captured trades
4. **EOD** — Check logs, review any agent lessons

## Daily Command Reference

```bash
# Check if running
ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'sudo systemctl is-active scrooge'

# Quick log peek
ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'tail -30 /home/admin/scrooge/logs/scrooge.log'

# Current positions
ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 \
    'cat /home/admin/scrooge/data/state.json | python3 -c "import sys,json; s=json.load(sys.stdin); print(f\"Positions: {len(s[chr(39)]positions[chr(39)])}, Cash: ${s[chr(39)]cash[chr(39)]}, PnL: ${s[chr(39)]dailyPnL[chr(39)]}\")"'

# Restart after config edit
ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'sudo systemctl restart scrooge'
```

## Emergency Stop

```bash
ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'sudo systemctl stop scrooge'
```

Bot is fully autonomous after start. No need to stay SSH'd in.
