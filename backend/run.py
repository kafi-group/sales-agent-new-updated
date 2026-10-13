"""
Start the Kafi Sales Agent API.

Runs database migrations automatically, then starts the server with hot-reload in dev.

Usage (from backend/):
    python run.py

Or from repo root:
    python run.py
"""

import os
import sys
from pathlib import Path

# Ensure imports and relative paths work regardless of cwd
_BACKEND_DIR = Path(__file__).resolve().parent
os.chdir(_BACKEND_DIR)
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

import uvicorn

from config import settings


def main() -> None:
    port = int(os.environ.get("PORT", settings.api_port))
    print(f"Starting server at http://{settings.api_host}:{port}")
    print(f"API docs: http://127.0.0.1:{port}/docs")
    print("Database migrations run automatically on app startup.")

    uvicorn.run(
        "main:app",
        host=settings.api_host,
        port=port,
        reload=settings.api_debug,
    )


if __name__ == "__main__":
    main()
