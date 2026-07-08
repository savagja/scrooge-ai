/**
 * Cron entry point for the standalone retrospective process.
 *
 * This script is designed to be triggered by a cron job after market close
 * (e.g., 5:00 PM ET weekdays). It can also be run manually to re-process
 * a specific date.
 *
 * Usage:
 *   npx tsx retrospective.ts                           # Today's date
 *   npx tsx retrospective.ts 2026-07-07                 # Specific date
 *   npx tsx retrospective.ts --force                   # Re-run today
 *   npx tsx retrospective.ts --force 2026-07-06         # Re-run specific date
 *
 * Crontab entry (runs at 5pm ET weekdays, log output to syslog):
 *   0 21 * * 1-5 cd /home/jonsavage/Projects/scrooge && /usr/bin/npx tsx retrospective.ts >> logs/retrospective.log 2>&1
 */

import "./src/retrospective/retro-cli.js";