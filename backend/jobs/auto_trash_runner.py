"""Scheduled Auto Trash learn + apply ticks."""

from __future__ import annotations

from typing import Any


def run_learn_tick() -> dict[str, Any]:
    from db.session import SessionLocal
    from modules import auto_trash

    db = SessionLocal()
    try:
        return auto_trash.learn_from_trash(db)
    finally:
        db.close()


def run_apply_tick() -> dict[str, Any]:
    from modules import auto_trash

    return auto_trash.process_enabled_users()
