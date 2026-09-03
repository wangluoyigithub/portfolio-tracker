#!/usr/bin/env python3
"""Create a consistent SQLite backup without stopping the web service."""

import os
import sqlite3
from datetime import datetime
from pathlib import Path


def main():
    source = Path(os.environ.get("PORTFOLIO_DB", "/app/data/portfolio.db"))
    backup_dir = Path(os.environ.get("PORTFOLIO_BACKUP_DIR", source.parent / "backups"))
    if not source.exists():
        print(f"No database found at {source}; backup skipped.")
        return

    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    destination = backup_dir / f"portfolio-{stamp}.db"

    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as source_db:
        with sqlite3.connect(destination) as backup_db:
            source_db.backup(backup_db)
    destination.chmod(0o600)
    print(f"Backup created: {destination}")


if __name__ == "__main__":
    main()
