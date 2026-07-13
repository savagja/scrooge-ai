#!/usr/bin/env python3
"""Repair a corrupted sql.js SQLite database by dumping+recreating."""
import sqlite3
import sys
import os

db_path = sys.argv[1] if len(sys.argv) > 1 else "data/research.db"
bak_path = db_path + ".bak"

# Backup
if os.path.exists(bak_path):
    print(f"Backup already exists at {bak_path}, skipping backup")
else:
    os.rename(db_path, bak_path)
    print(f"Backed up to {bak_path}")

try:
    # Try to open the corrupt file and get schema + data
    old = sqlite3.connect(bak_path)
    
    # Get schema
    schema = []
    for row in old.execute("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL ORDER BY name"):
        schema.append(row[0])
    
    # Get indexes
    for row in old.execute("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name"):
        schema.append(row[0])
    
    # Create new database
    new = sqlite3.connect(db_path)
    for s in schema:
        try:
            new.execute(s)
        except Exception as e:
            print(f"  Schema error on: {s[:50]}... {e}")
    new.commit()
    
    # Copy data table by table
    tables = [r[0] for r in old.execute("SELECT name FROM sqlite_master WHERE type='table' AND name != '_internal' ORDER BY name")]
    
    for table in tables:
        try:
            rows = old.execute(f"SELECT * FROM [{table}]").fetchall()
            if not rows:
                print(f"  {table}: 0 rows (empty)")
                continue
            
            cols = [d[0] for d in old.execute(f"SELECT * FROM [{table}] LIMIT 0").description]
            placeholders = ",".join(["?"] * len(cols))
            col_names = ",".join(f"[{c}]" for c in cols)
            
            new.executemany(f"INSERT INTO [{table}] ({col_names}) VALUES ({placeholders})", rows)
            new.commit()
            print(f"  {table}: {len(rows)} rows recovered")
        except Exception as e:
            print(f"  {table}: ERROR - {e}")
    
    old.close()
    new.close()
    print(f"\n✅ Database repaired at {db_path}")
    
except Exception as e:
    print(f"❌ Repair failed: {e}")
    if os.path.exists(bak_path) and not os.path.exists(db_path):
        os.rename(bak_path, db_path)
        print("Restored backup")
    sys.exit(1)