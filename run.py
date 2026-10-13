"""Convenience launcher — run the backend from the repo root."""

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent / "backend"

os.chdir(BACKEND_DIR)
sys.path.insert(0, str(BACKEND_DIR))

from run import main  # noqa: E402

if __name__ == "__main__":
    main()
