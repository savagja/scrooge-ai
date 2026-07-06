#!/usr/bin/env python3
"""
Deploy Scrooge to the Pi using the existing connection infrastructure.

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
    print("Validating local setup...")
    env_path = os.path.join(LOCAL_DIR, ".env")
    if not os.path.exists(env_path):
        print("  .env not found. Copy .env.example and fill in keys.")
        sys.exit(1)
    with open(env_path) as f:
        contents = f.read()
        if "ALPACA_API_KEY" not in contents or "OPENROUTER_API_KEY" not in contents:
            print("  .env missing required keys")
            sys.exit(1)
    print("   .env valid")


def sync(ssh):
    print()
    print("Syncing to Pi...")
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
    print("   Synced")


def remote_setup(ssh):
    print()
    print("Running remote setup...")

    run_cmd(ssh, "mkdir -p {0} {0}/data {0}/logs".format(REMOTE_DIR))

    # Install deps
    out, err = run_cmd(ssh, "cd {0} && npm install --omit=dev 2>&1".format(REMOTE_DIR))
    print("   Dependencies installed")

    # Secure .env
    run_cmd(ssh, "chmod 600 {0}/.env".format(REMOTE_DIR))
    print("   .env secured")

    # Install strategist systemd service
    strategist_service = (
        "[Unit]\n"
        "Description=Scrooge Strategist - forms trading hypotheses\n"
        "After=network-online.target\n"
        "Wants=network-online.target\n"
        "\n"
        "[Service]\n"
        "Type=simple\n"
        "User=admin\n"
        "WorkingDirectory={0}\n"
        'Environment="NODE_ENV=production"\n'
        'EnvironmentFile={0}/.env\n'
        "ExecStart=/usr/bin/npx tsx strategist.ts\n"
        "Restart=on-failure\n"
        "RestartSec=30\n"
        "StandardOutput=append:{0}/logs/strategist.log\n"
        "StandardError=append:{0}/logs/strategist.log\n"
        "\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    ).format(REMOTE_DIR)

    stdin, stdout, stderr = ssh.exec_command("sudo tee /etc/systemd/system/scrooge-strategist.service")
    stdin.write(strategist_service)
    stdin.channel.shutdown_write()
    stdout.read()
    stderr.read()
    print("   Strategist service written")

    # Install trader systemd service
    trader_service = (
        "[Unit]\n"
        "Description=Scrooge Trader - executes strategies\n"
        "After=network-online.target\n"
        "Wants=network-online.target\n"
        "\n"
        "[Service]\n"
        "Type=simple\n"
        "User=admin\n"
        "WorkingDirectory={0}\n"
        'Environment="NODE_ENV=production"\n'
        'EnvironmentFile={0}/.env\n'
        "ExecStart=/usr/bin/npx tsx trader.ts\n"
        "Restart=on-failure\n"
        "RestartSec=30\n"
        "StandardOutput=append:{0}/logs/trader.log\n"
        "StandardError=append:{0}/logs/trader.log\n"
        "\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    ).format(REMOTE_DIR)

    stdin, stdout, stderr = ssh.exec_command("sudo tee /etc/systemd/system/scrooge-trader.service")
    stdin.write(trader_service)
    stdin.channel.shutdown_write()
    stdout.read()
    stderr.read()
    print("   Trader service written")

    # Remove old single service if it exists
    run_cmd(ssh, "sudo systemctl disable scrooge.service 2>/dev/null; sudo rm -f /etc/systemd/system/scrooge.service")

    run_cmd(ssh, "sudo systemctl daemon-reload")
    run_cmd(ssh, "sudo systemctl enable scrooge-strategist.service")
    run_cmd(ssh, "sudo systemctl enable scrooge-trader.service")
    print("   Services enabled (not started)")


def main():
    print("=== Scrooge Pi Deploy (Dobby-backed) ===")
    print()

    validate()

    print("Connecting to Pi via Dobby helper...")
    ssh = connect(os.path.join(DOBBY_PI, "connection.json"))
    print("   Connected")

    sync(ssh)
    remote_setup(ssh)
    ssh.close()

    print()
    print("==========================================")
    print("  DEPLOYED to admin@192.168.50.42")
    print("==========================================")
    print()
    print("Start both:")
    print("  ssh -i ~/.ssh/id_ed25519_pi admin@192.168.50.42 \\")
    print("    'sudo systemctl start scrooge-strategist scrooge-trader'")
    print()
    print("View logs:")
    print("  Strategist: sudo journalctl -u scrooge-strategist -f")
    print("  Trader:     sudo journalctl -u scrooge-trader -f")
    print()
    print("Stop:")
    print("  ssh ... 'sudo systemctl stop scrooge-strategist scrooge-trader'")


if __name__ == "__main__":
    main()