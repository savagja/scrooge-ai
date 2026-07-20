# Deployment

**Target:** Any server (e.g., a VPS, home server, or cloud VM)
- OS: Linux with systemd
- Node.js 20+
- systemd services: `scrooge-strategist.service` + `scrooge-trader.service`
- Bot logs: `logs/`
- State: `data/`
- API: `http://<host-ip>:5000/api/`

## How to Deploy

When deploying code changes to your server, use the deploy scripts at `deploy/`. The process:

1. **Commit or at least save** all changes locally first (deploy ships the entire working tree)
2. **Run the deploy script** from the scrooge root:
   ```bash
   # Option A: Python (preferred — uses paramiko, handles .env, deps, service restart)
   python deploy/deploy.py

   # Option B: Bash (fallback if Python deps missing)
   chmod +x deploy/deploy.sh
   ./deploy/deploy.sh
   ```
3. The deploy script will:
   - Validate `.env` exists with API keys
   - Create a tarball of the repo (excluding `node_modules/`, `data/`, `logs/`)
   - SCP it to the server
   - Extract on server
   - Run `npm install` (skipped if `node_modules` already fresh)
   - Restart the relevant systemd services (`scrooge-trader`, `scrooge-strategist`, `scrooge-api`)
4. **Verify post-deploy**:
   ```bash
   ssh <user>@<pi-ip>
   sudo systemctl status scrooge-trader scrooge-strategist
   tail -30 logs/scrooge.log
   ```
5. **If the deploy includes new files or structural changes**, also deploy the API:
   ```bash
   # The deploy script handles this, but double-check:
   ssh <user>@<pi-ip> 'sudo systemctl restart scrooge-api'
   ```

## Pre-deploy Checklist

- [ ] Does `.env` exist with `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `OPENROUTER_API_KEY`?
- [ ] Is `ALPACA_PAPER=true` in `.env`? (Unless intentionally going live)
- [ ] Does `npx tsc --noEmit` pass cleanly?
- [ ] Has `config.yaml` been reviewed for the new changes?
- [ ] Are the systemd service files up to date? (`deploy/` carries them)

## Emergency Rollback

```bash
ssh <user>@<pi-ip>
cd ~/scrooge
# Previous deploy is in /tmp/scrooge-deploy-*.tar.gz — extract it:
sudo tar xzf /tmp/scrooge-deploy-*.tar.gz -C ~/scrooge
sudo systemctl restart scrooge-trader scrooge-strategist
```

## ⚠️ Data Source Convention

**The deployed server is the canonical data source for all information about Scrooge in production.** The local development environment (`data/`) contains only test/fixture data and should NEVER be used when answering questions about the running system.

When asked about status, summaries, reports, positions, trades, strategies, lessons, P&L, or any other runtime state:

1. **Always pull from the deployed server first.** Use SSH (`ssh <user>@<host-ip>`) or the Flask API (`http://<host-ip>:5000/api/...`) to read the actual production data.
2. **FLASK API endpoints** (preferred — uses HTTP, no SSH needed):
   - `GET /api/status` — Account summary, cash, positions, daily P&L
   - `GET /api/report` — Latest daily retrospective report (full markdown)
   - `GET /api/reports` — All daily reports
   - `GET /api/positions` — Current open positions
   - `GET /api/trades` — Recent trade history
   - `GET /api/strategies` — Current strategy lifecycle state counts
   - `GET /api/activity` — Recent activity stream
   - `GET /api/memory` — Lessons, calibration table, context notes
   - `GET /api/state` — Full persisted state.json dump
3. **SSH file access** (if API is down):
   - State: `cat data/state.json`
   - Strategies: use `node -e` with better-sqlite3 on the server (or copy the db)
   - Logs: `tail -100 logs/scrooge.log`
   - Service status: `systemctl status scrooge-trader scrooge-strategist`
4. **Do NOT read local `data/state.json`** for production queries. It's a test file with placeholder data. Always preface answers about production state with "From the deployed server: ..."

## SSH Quick Reference

```bash
ssh <user>@<pi-ip>
# then:
cat ~/scrooge/data/state.json | jq '.cash, .positions, .dailyPnL'
tail -50 ~/scrooge/logs/scrooge.log
systemctl status scrooge-trader
systemctl status scrooge-strategist
journalctl -u scrooge-trader --since today
```

## API Quick Reference

```bash
# Status overview
curl -s http://<pi-ip>:5000/api/status | jq .

# Latest retrospective report
curl -s http://<pi-ip>:5000/api/report | jq '.markdown[:500]'

# Current positions
curl -s http://<pi-ip>:5000/api/positions | jq .

# Strategy lifecycle counts
curl -s http://<pi-ip>:5000/api/strategies | jq '.stateCounts'
```