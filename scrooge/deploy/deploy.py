#!/usr/bin/env python3
"""
Deploy Scrooge to the Dobby Pi using the existing connection infrastructure.

Usage:
    python deploy/deploy.py

Prerequisites:
    - Dobby repo must exist at ../dobby/
    - Pi SSH key auth configured (id_ed25519_pi)
"""

import os
import subprocess
import sys

# Add Dobby's helpers to path
DOBBY_PI = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "dobby", "pi")
sys.path.insert(0, DOBBY_PI)

from connect import connect, run_cmd

LOCAL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REMOTE_DIR = "/home/admin/scrooge"


def validate():
    print("🔍 Validating local setup...")
    env_path = os.path.join(LOCAL_DIR, ".env")
    if not os.path.exists(env_path):
        print("❌ .env not found. Copy .env.example and fill in keys.")
        sys.exit(1)
    with open(env_path) as f:
        contents = f.read()
        if "ALPACA_API_KEY" not in contents or "OPENROUTER_API_KEY" not in contents:
            print("❌ .env missing required keys")
            sys.exit(1)
    print("   ✅ .env valid")


def sync(ssh):
    print()
    print("📤 Syncing to Pi...")
    cmd = [
        "rsync", "-avz", "--delete",
        "-e", "ssh -i ~/.ssh/id_ed25519_pi -o StrictHostKeyChecking=accept-new",
        "--exclude", "node_modules",
        "--exclude", "data",
        "--exclude", "logs",
        "--exclude", ".git",
        "--exclude", "dist",
        "--exclude", "deploy/",
        f"{LOCAL_DIR}/",
        f"admin@192.168.50.42:{REMOTE_DIR}/",
    ]
    subprocess.run(cmd, check=True)
    print("   ✅ Synced")


def remote_setup(ssh):
    print()
    print("🔧 Running remote setup...")

    run_cmd(ssh, f"mkdir -p {REMOTE_DIR} {REMOTE_DIR}/data {REMOTE_DIR}/logs")

    # Install deps
    out, err = run_cmd(ssh, f"cd {REMOTE_DIR} && npm install --omit=dev 2>&1")
    print("   📦 Dependencies installed")

    # Secure .env
    run_cmd(ssh, f"chmod 600 {REMOTE_DIR}/.env")
    print("   🔒 .env secured")

    # Install systemd service
    service_body = f"""[Unit]
Description=Scrooge AI Trading Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=admin
WorkingDirectory={REMOTE_DIR}
Environment="NODE_ENV=production"
EnvironmentFile={REMOTE_DIR}/.env
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=on-failure
RestartSec=30
StandardOutput=append:{REMOTE_DIR}/logs/scrooge.log
StandardError=append:{REMOTE_DIR}/logs/scrooge.log

[Install]
WantedBy=multi-user.target
"""

    stdin, stdout, stderr = ssh.exec_command("sudo tee /etc/systemd/system/scrooge.service")
    stdin.write(service_body)
    stdin.channel.shutdown_write()
    stdout.read()
    stderr.read()
    print("   ⚙️  systemd service written")

    run_cmd(ssh, "sudo systemctl daemon-reload")
    run_cmd(ssh, "sudo systemctl enable scrooge.service")
    print("   ✅ Service enabled (not started)")


def main():
    print("═══ Scrooge Pi Deploy (Dobby-backed) ═══")
    print()

    validate()

    print("🔗 Connecting to Pi via Dobby helper...")
    ssh = connect(os.path.join(DOBBY_PI, "connection.json"))
    print("   ✅ Connected")

    sync(ssh)
    remote_setup(ssh)
    ssh.close()

    print()
    print("═══════════════════════════════════════════════════════")
    print("  ✅ DEPLOYED to admin@192.168.50.42:/home/admin/scrooge")
    print("═══════════════════════════════════════════════════════")
    print()
    print("Next:")
    print("  Test:     ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42")
    print("            cd /home/admin/scrooge && DRY_RUN=true npx tsx src/index.ts")
    print()
    print("  Start:    ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'sudo systemctl start scrooge'")
    print("  Logs:     ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'sudo journalctl -u scrooge -f'")
    print("  Stop:     ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 'sudo systemctl stop scrooge'")
    print()


if __name__ == "__main__":
    main()
