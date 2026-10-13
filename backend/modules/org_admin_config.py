"""Org admin config: Active Master Lists + AI Sales Agents registry.

Persisted on Railway volume (/data) when available so lists survive redeploys.
Local/dev falls back to backend/data/. Does not alter queues, Twilio, WhatsApp, or mail.
Sara (female) and Rayan (male) are seeded and protected (rename/active only; no delete).
"""

from __future__ import annotations

import json
import os
import re
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_REPO_DATA_PATH = _BACKEND_DIR / "data" / "org_admin_config.json"


def _resolve_data_path() -> Path:
    """Prefer persistent Railway volume so master lists survive deploys."""
    override = (os.environ.get("ORG_ADMIN_CONFIG_PATH") or "").strip()
    if override:
        return Path(override)
    for candidate in (
        Path("/data/org_admin_config.json"),
        Path("/data/storage/org_admin_config.json"),
    ):
        parent = candidate.parent
        try:
            if parent.is_dir() and os.access(parent, os.W_OK):
                return candidate
        except OSError:
            continue
    return _REPO_DATA_PATH


_DATA_PATH = _resolve_data_path()
_LOCK = threading.Lock()

_DEFAULT_MASTER_LISTS: list[dict[str, Any]] = [
    {"key": "fmcg", "label": "Master FMCG", "enabled": True, "sort_order": 0},
    {"key": "minerals_ores", "label": "Minerals & Ores", "enabled": True, "sort_order": 1},
    {"key": "other_items", "label": "Other Items", "enabled": True, "sort_order": 2},
]

_DEFAULT_AGENTS: list[dict[str, Any]] = [
    {
        "id": "female",
        "name": "Sara",
        "active": True,
        "product_focus": "",
        "voice": "en-US-Neural2-F",
        "gender_label": "female",
        "protected": True,
    },
    {
        "id": "male",
        "name": "Rayan",
        "active": True,
        "product_focus": "",
        "voice": "en-US-Neural2-D",
        "gender_label": "male",
        "protected": True,
    },
]


def _default_store() -> dict[str, Any]:
    return {
        "master_lists": deepcopy(_DEFAULT_MASTER_LISTS),
        # user_id (str) -> list of master list keys; missing user = all enabled lists
        "user_master_access": {},
        # agent_id -> list of master list keys; missing agent = all enabled lists
        "agent_master_access": {},
        "ai_sales_agents": deepcopy(_DEFAULT_AGENTS),
    }


_MEMORY: dict[str, Any] | None = None


def _migrate_repo_copy_if_needed() -> None:
    """If volume path is empty but repo/ephemeral file has data, copy once."""
    if _DATA_PATH == _REPO_DATA_PATH:
        return
    if _DATA_PATH.exists():
        return
    if not _REPO_DATA_PATH.exists():
        return
    try:
        _DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
        _DATA_PATH.write_text(_REPO_DATA_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    except OSError:
        pass


def _ensure_file() -> None:
    global _MEMORY
    try:
        _DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
        _migrate_repo_copy_if_needed()
        if not _DATA_PATH.exists():
            _DATA_PATH.write_text(json.dumps(_default_store(), indent=2), encoding="utf-8")
    except OSError:
        if _MEMORY is None:
            _MEMORY = _default_store()


def _load() -> dict[str, Any]:
    global _MEMORY
    _ensure_file()
    if _MEMORY is not None and not _DATA_PATH.exists():
        return deepcopy(_MEMORY)
    try:
        raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return deepcopy(_MEMORY) if _MEMORY is not None else _default_store()
    if not isinstance(raw, dict):
        return _default_store()
    base = _default_store()
    lists = raw.get("master_lists")
    if isinstance(lists, list) and lists:
        cleaned: list[dict[str, Any]] = []
        for i, row in enumerate(lists):
            if not isinstance(row, dict):
                continue
            key = _slug_key(str(row.get("key") or row.get("label") or f"list_{i}"))
            if not key:
                continue
            cleaned.append(
                {
                    "key": key,
                    "label": str(row.get("label") or key).strip() or key,
                    "enabled": bool(row.get("enabled", True)),
                    "sort_order": int(row.get("sort_order") if row.get("sort_order") is not None else i),
                }
            )
        if cleaned:
            base["master_lists"] = cleaned
    access = raw.get("user_master_access")
    if isinstance(access, dict):
        out_access: dict[str, list[str]] = {}
        for uid, keys in access.items():
            if isinstance(keys, list):
                out_access[str(uid)] = [str(k) for k in keys if str(k).strip()]
        base["user_master_access"] = out_access
    agent_access = raw.get("agent_master_access")
    if isinstance(agent_access, dict):
        out_agents: dict[str, list[str]] = {}
        for aid, keys in agent_access.items():
            if isinstance(keys, list):
                out_agents[str(aid)] = [str(k) for k in keys if str(k).strip()]
        base["agent_master_access"] = out_agents
    agents = raw.get("ai_sales_agents")
    if isinstance(agents, list) and agents:
        cleaned_a: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in agents:
            if not isinstance(row, dict):
                continue
            aid = str(row.get("id") or "").strip()
            if not aid or aid in seen:
                continue
            seen.add(aid)
            cleaned_a.append(
                {
                    "id": aid,
                    "name": str(row.get("name") or aid).strip() or aid,
                    "active": bool(row.get("active", True)),
                    "product_focus": str(row.get("product_focus") or "").strip(),
                    "voice": str(row.get("voice") or "en-US-Neural2-D").strip() or "en-US-Neural2-D",
                    "gender_label": str(row.get("gender_label") or aid).strip() or aid,
                    "protected": bool(row.get("protected", aid in ("female", "male"))),
                }
            )
        # Sara = female + Neural2-F; Rayan = male + Neural2-D — always on load.
        from modules.ai_agent_persona import FEMALE_VOICE, MALE_VOICE, enforce_sara_rayan_agent

        cleaned_a = [enforce_sara_rayan_agent(r) for r in cleaned_a]
        for r in cleaned_a:
            if r.get("id") == "female":
                r["gender_label"] = "female"
                r["voice"] = FEMALE_VOICE
                r["protected"] = True
            elif r.get("id") == "male":
                r["gender_label"] = "male"
                r["voice"] = MALE_VOICE
                r["protected"] = True
        # Always keep Sara/Rayan present
        for seed in _DEFAULT_AGENTS:
            if seed["id"] not in seen:
                cleaned_a.insert(0 if seed["id"] == "female" else 1, deepcopy(seed))
        if cleaned_a:
            base["ai_sales_agents"] = cleaned_a
    _MEMORY = deepcopy(base)
    return base


def _save(data: dict[str, Any]) -> None:
    global _MEMORY
    _MEMORY = deepcopy(data)
    try:
        _ensure_file()
        _DATA_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except OSError:
        # Ephemeral / read-only disk — keep in-memory so Settings still works.
        pass


def _slug_key(raw: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (raw or "").strip().lower()).strip("_")
    return s[:64]


def get_master_lists(*, include_disabled: bool = False) -> list[dict[str, Any]]:
    data = _load()
    rows = list(data.get("master_lists") or [])
    rows.sort(key=lambda r: (int(r.get("sort_order") or 0), str(r.get("label") or "")))
    if include_disabled:
        return rows
    return [r for r in rows if r.get("enabled")]


def master_keys_for_user(user_id: int | None, *, is_admin: bool = False) -> list[str]:
    """Keys the user may select. Admin / unset access → all enabled lists."""
    enabled = get_master_lists(include_disabled=False)
    enabled_keys = [str(r["key"]) for r in enabled]
    if is_admin or user_id is None:
        return enabled_keys
    data = _load()
    access = data.get("user_master_access") or {}
    raw = access.get(str(int(user_id)))
    if raw is None:
        return enabled_keys
    allowed = {str(k) for k in raw}
    return [k for k in enabled_keys if k in allowed]


def get_user_master_access() -> dict[str, list[str]]:
    return dict(_load().get("user_master_access") or {})


def upsert_master_list(
    *,
    key: str | None,
    label: str,
    enabled: bool = True,
    sort_order: int | None = None,
) -> dict[str, Any]:
    label = (label or "").strip()
    if not label:
        raise ValueError("Label is required")
    with _LOCK:
        data = _load()
        rows = list(data.get("master_lists") or [])
        k = _slug_key(key or label)
        if not k:
            raise ValueError("Invalid list key")
        existing = next((r for r in rows if r.get("key") == k), None)
        if existing:
            existing["label"] = label
            existing["enabled"] = bool(enabled)
            if sort_order is not None:
                existing["sort_order"] = int(sort_order)
            row = existing
        else:
            order = (
                int(sort_order)
                if sort_order is not None
                else (max((int(r.get("sort_order") or 0) for r in rows), default=-1) + 1)
            )
            row = {"key": k, "label": label, "enabled": bool(enabled), "sort_order": order}
            rows.append(row)
        data["master_lists"] = rows
        _save(data)
        return row


def delete_master_list(key: str) -> None:
    k = _slug_key(key)
    if k in {"fmcg", "minerals_ores", "other_items"}:
        raise ValueError("Built-in master lists cannot be deleted — disable them instead.")
    with _LOCK:
        data = _load()
        rows = [r for r in (data.get("master_lists") or []) if r.get("key") != k]
        if len(rows) == len(data.get("master_lists") or []):
            raise ValueError("Master list not found")
        data["master_lists"] = rows
        access = data.get("user_master_access") or {}
        for uid, keys in list(access.items()):
            access[uid] = [x for x in keys if x != k]
        data["user_master_access"] = access
        a_access = data.get("agent_master_access") or {}
        for aid, keys in list(a_access.items()):
            a_access[aid] = [x for x in keys if x != k]
        data["agent_master_access"] = a_access
        _save(data)


def set_user_master_access(user_id: int, keys: list[str]) -> list[str]:
    valid = {str(r["key"]) for r in get_master_lists(include_disabled=True)}
    cleaned = [k for k in keys if k in valid]
    with _LOCK:
        data = _load()
        access = dict(data.get("user_master_access") or {})
        access[str(int(user_id))] = cleaned
        data["user_master_access"] = access
        _save(data)
    return cleaned


def get_agent_master_access() -> dict[str, list[str]]:
    return dict(_load().get("agent_master_access") or {})


def set_agent_master_access(agent_id: str, keys: list[str]) -> list[str]:
    aid = str(agent_id or "").strip()
    if not aid:
        raise ValueError("Agent id required")
    if not get_ai_agent(aid):
        raise ValueError("Agent not found")
    valid = {str(r["key"]) for r in get_master_lists(include_disabled=True)}
    cleaned = [k for k in keys if k in valid]
    with _LOCK:
        data = _load()
        access = dict(data.get("agent_master_access") or {})
        access[aid] = cleaned
        data["agent_master_access"] = access
        _save(data)
    return cleaned


def master_keys_for_agent(agent_id: str) -> list[str]:
    """Master list keys for an AI Sales Agent.

    Unset (never configured) → all enabled lists (Sara/Rayan stay visible by default).
    Explicit empty list → none (e.g. Rice with no agents ticked).
    """
    enabled_keys = [str(r["key"]) for r in get_master_lists(include_disabled=False)]
    access_map = get_agent_master_access()
    aid = str(agent_id or "").strip()
    if aid not in access_map:
        return enabled_keys
    allowed = {str(k) for k in (access_map.get(aid) or [])}
    return [k for k in enabled_keys if k in allowed]


def list_ai_sales_agents(*, active_only: bool = False) -> list[dict[str, Any]]:
    rows = list(_load().get("ai_sales_agents") or [])
    if active_only:
        rows = [r for r in rows if r.get("active")]
    return rows


def get_ai_agent(agent_id: str) -> dict[str, Any] | None:
    aid = str(agent_id or "").strip()
    return next((r for r in list_ai_sales_agents() if r.get("id") == aid), None)


def agent_display_name(agent_id: str) -> str:
    from modules.ai_agent_persona import persona_display_name

    row = get_ai_agent(agent_id)
    if row:
        return persona_display_name(
            agent_id,
            display_name=str(row.get("name") or ""),
            gender_label=str(row.get("gender_label") or ""),
            voice=str(row.get("voice") or ""),
        )
    return persona_display_name(agent_id)


def active_agent_ids() -> list[str]:
    return [str(r["id"]) for r in list_ai_sales_agents(active_only=True)]


def upsert_ai_sales_agent(
    *,
    agent_id: str | None,
    name: str,
    active: bool = True,
    product_focus: str = "",
    voice: str | None = None,
) -> dict[str, Any]:
    name = (name or "").strip()
    if not name:
        raise ValueError("Agent name is required")
    with _LOCK:
        data = _load()
        rows = list(data.get("ai_sales_agents") or [])
        if agent_id:
            aid = str(agent_id).strip()
        else:
            aid = _slug_key(f"agent_{name}")
            if not aid or aid in ("female", "male", "pipeline"):
                aid = f"agent_{abs(hash(name)) % 10_000_000}"
            base = aid
            n = 2
            existing_ids = {str(r.get("id")) for r in rows}
            while aid in existing_ids:
                aid = f"{base}_{n}"
                n += 1
        existing = next((r for r in rows if r.get("id") == aid), None)
        if existing:
            existing["name"] = name
            existing["active"] = bool(active)
            existing["product_focus"] = (product_focus or "").strip()
            if voice:
                existing["voice"] = voice.strip()
            row = existing
        else:
            row = {
                "id": aid,
                "name": name,
                "active": bool(active),
                "product_focus": (product_focus or "").strip(),
                "voice": (voice or "en-US-Neural2-D").strip(),
                "gender_label": aid,
                "protected": aid in ("female", "male"),
            }
            rows.append(row)
        from modules.ai_agent_persona import (
            FEMALE_VOICE,
            MALE_VOICE,
            enforce_sara_rayan_agent,
        )

        # Sara = female + Neural2-F; Rayan = male + Neural2-D — always.
        row = enforce_sara_rayan_agent(row)
        if aid == "female":
            row["gender_label"] = "female"
            row["voice"] = FEMALE_VOICE
            row["protected"] = True
        elif aid == "male":
            row["gender_label"] = "male"
            row["voice"] = MALE_VOICE
            row["protected"] = True
        data["ai_sales_agents"] = rows
        _save(data)
        return row


def delete_ai_sales_agent(agent_id: str) -> None:
    aid = str(agent_id or "").strip()
    row = get_ai_agent(aid)
    if not row:
        raise ValueError("Agent not found")
    if row.get("protected") or aid in ("female", "male"):
        raise ValueError("Sara and Rayan cannot be removed — set them inactive instead.")
    with _LOCK:
        data = _load()
        data["ai_sales_agents"] = [r for r in (data.get("ai_sales_agents") or []) if r.get("id") != aid]
        access = dict(data.get("agent_master_access") or {})
        access.pop(aid, None)
        data["agent_master_access"] = access
        _save(data)


def admin_snapshot() -> dict[str, Any]:
    return {
        "master_lists": get_master_lists(include_disabled=True),
        "user_master_access": get_user_master_access(),
        "agent_master_access": get_agent_master_access(),
        "ai_sales_agents": list_ai_sales_agents(active_only=False),
    }
