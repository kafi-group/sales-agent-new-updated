"""HTTP client for Baileys WhatsApp bridge — isolated per Sales Agent user session."""

from __future__ import annotations

import base64
import threading
import time
from typing import Any

import httpx

from config import settings


DEFAULT_USER_BRIDGES: dict[str, str] = {
    "khalid": "https://whatsapp-bridge-production-ffd3.up.railway.app",
    "admin": "https://whatsapp-bridge-production-ffd3.up.railway.app",
    "asim": "https://whatsapp-bridge-production-8eee.up.railway.app",
    "usmankhan": "https://whatsapp-bridge-production-9587.up.railway.app",
    "usman": "https://whatsapp-bridge-production-9587.up.railway.app",
    "sadia": "https://whatsapp-bridge-production-8388.up.railway.app",
}

DEFAULT_USER_ID_BRIDGES: dict[int, str] = {
    1: "https://whatsapp-bridge-production-ffd3.up.railway.app",  # admin / khalid
    2: "https://whatsapp-bridge-production-8eee.up.railway.app",  # asim
    3: "https://whatsapp-bridge-production-9587.up.railway.app",  # usmankhan
    4: "https://whatsapp-bridge-production-8388.up.railway.app",  # sadia
}

_OWNER_ALIASES: dict[str, str] = {
    "admin": "khalid",
    "khalid": "khalid",
    "mrkhalid": "khalid",
    "khaled": "khalid",
    "khaledparacha": "khalid",
    "asim": "asim",
    "usman": "usman",
    "usmankhan": "usman",
    "sadia": "sadia",
}

_STATUS_CACHE_TTL = 20.0
_status_cache: dict[int, tuple[float, dict[str, Any]]] = {}
_status_cache_lock = threading.Lock()


def _norm_username(username: str | None) -> str:
    return "".join(ch for ch in (username or "").strip().lower() if ch.isalnum())


def bridge_owner_key(username: str | None, user_id: int | None = None) -> str | None:
    """Map any login alias to a dedicated bridge owner. Not tied to a PC."""
    aliased = _OWNER_ALIASES.get(_norm_username(username))
    if aliased:
        return aliased
    if user_id in DEFAULT_USER_ID_BRIDGES:
        return {1: "khalid", 2: "asim", 3: "usman", 4: "sadia"}.get(int(user_id))
    return None


def bridge_session_id(user_id: int, username: str | None = None) -> str:
    """Namespace sessions so each user's bridge container has a clean session."""
    prefix = (settings.whatsapp_bridge_session_prefix or "kafi-sales-agent").strip()
    clean_name = (username or "").strip().lower()
    if clean_name:
        return f"{prefix}-{clean_name}"
    return f"{prefix}-u{int(user_id)}"


def _headers() -> dict[str, str]:
    secret = (settings.whatsapp_bridge_secret or "4ce746274829595960813f40c4ee4c355b351b5ee41fc83f").strip()
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if secret:
        headers["x-bridge-secret"] = secret
    return headers


# Keep QR/bridge calls short so a disconnect cannot starve email, Cloud inbox, or leads.
_STATUS_TIMEOUT = 4.0
_QR_TIMEOUT = 8.0
_PAIR_TIMEOUT = 12.0
_DISCONNECT_TIMEOUT = 5.0
_SEND_TIMEOUT = 15.0


def _base_url(user_id: int | None = None, username: str | None = None) -> str:
    """Resolve the dedicated WhatsApp bridge for this Sales Agent login (any PC)."""
    owner = bridge_owner_key(username, user_id)
    clean_name = (username or "").strip().lower()

    if owner == "khalid":
        custom = (settings.whatsapp_bridge_url_khalid or settings.whatsapp_bridge_url_admin or "").strip().rstrip("/")
        if custom:
            return custom
        return DEFAULT_USER_BRIDGES["khalid"]
    if owner == "asim":
        custom = (settings.whatsapp_bridge_url_asim or "").strip().rstrip("/")
        if custom:
            return custom
        return DEFAULT_USER_BRIDGES["asim"]
    if owner == "usman":
        custom = (settings.whatsapp_bridge_url_usman or "").strip().rstrip("/")
        if custom:
            return custom
        return DEFAULT_USER_BRIDGES["usman"]
    if owner == "sadia":
        custom = (settings.whatsapp_bridge_url_sadia or "").strip().rstrip("/")
        if custom:
            return custom
        return DEFAULT_USER_BRIDGES["sadia"]

    if clean_name and clean_name in DEFAULT_USER_BRIDGES:
        return DEFAULT_USER_BRIDGES[clean_name]
    if user_id is not None and user_id in DEFAULT_USER_ID_BRIDGES:
        return DEFAULT_USER_ID_BRIDGES[user_id]

    # Unknown login: keep a unique session id, but do not steal Khalid's container.
    general = (settings.whatsapp_bridge_url or "").strip().rstrip("/")
    if general:
        return general
    return DEFAULT_USER_BRIDGES["khalid"]


def _extract_phone_number(data: dict[str, Any]) -> str | None:
    for key in ("phone", "connectedPhone", "number", "wa_number", "waNumber", "jid", "wid"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            raw = val.split("@")[0].split(":")[0].strip()
            digits = "".join(ch for ch in raw if ch.isdigit())
            if len(digits) >= 8:
                return f"+{digits}"
    user_obj = data.get("user") or data.get("me") or data.get("info")
    if isinstance(user_obj, dict):
        return _extract_phone_number(user_obj)
    return None


def _normalize_status(data: dict[str, Any]) -> dict[str, Any]:
    """Bridge uses status: connected | qr-pending | disconnected — normalize for UI."""
    raw_status = str(data.get("status") or "").strip().lower()
    raw_conn = data.get("connected")
    
    if raw_status in {"disconnected", "qr-pending", "connecting", "close", "closed", "logged_out", ""}:
        data["connected"] = False
        data["status"] = raw_status if raw_status else "disconnected"
    elif raw_conn is False:
        data["connected"] = False
        if raw_status not in {"connecting", "qr-pending"}:
            data["status"] = "disconnected"
    else:
        data["connected"] = bool(raw_conn) or raw_status in {"connected", "open", "ready"}

    phone = _extract_phone_number(data) if data["connected"] else None
    if phone:
        data["phone"] = phone
        data["connectedPhone"] = phone
    else:
        data["phone"] = None
        data["connectedPhone"] = None

    return data


def _png_qr_payload(session: str, content: bytes) -> dict[str, Any]:
    b64 = base64.b64encode(content).decode("ascii")
    return {
        "session": session,
        "connected": False,
        "status": "qr-pending",
        "qr": b64,
        "qrDataUrl": f"data:image/png;base64,{b64}",
    }


def _response_is_png(resp: httpx.Response) -> bool:
    content_type = (resp.headers.get("content-type") or "").lower()
    if "image/" in content_type:
        return True
    body = resp.content or b""
    return len(body) >= 4 and body[:4] == b"\x89PNG"


def bridge_status(user_id: int, username: str | None = None) -> dict[str, Any]:
    session = bridge_session_id(user_id, username=username)
    base_url = _base_url(user_id=user_id, username=username)
    try:
        with httpx.Client(timeout=_STATUS_TIMEOUT) as client:
            resp = client.get(
                f"{base_url}/status",
                params={"session": session},
                headers=_headers(),
            )
            if resp.status_code == 401:
                return {"connected": False, "session": session, "status": "disconnected", "error": "Bridge unauthorized"}
            resp.raise_for_status()
            data = resp.json() if resp.content else {}
            if not isinstance(data, dict):
                data = {}
            data.setdefault("session", session)
            normalized = _normalize_status(data)
            _store_status_cache(user_id, normalized)
            return normalized
    except Exception:  # noqa: BLE001
        disconnected = {"connected": False, "session": session, "status": "disconnected"}
        _store_status_cache(user_id, disconnected)
        return disconnected


def _store_status_cache(user_id: int, data: dict[str, Any]) -> None:
    with _status_cache_lock:
        _status_cache[int(user_id)] = (time.monotonic(), data)


def peek_cached_status(user_id: int) -> dict[str, Any] | None:
    with _status_cache_lock:
        hit = _status_cache.get(int(user_id))
        if not hit:
            return None
        ts, data = hit
        if (time.monotonic() - ts) > _STATUS_CACHE_TTL:
            return None
        return data


def invalidate_status_cache(user_id: int | None = None) -> None:
    with _status_cache_lock:
        if user_id is None:
            _status_cache.clear()
        else:
            _status_cache.pop(int(user_id), None)


def bridge_qr(user_id: int, username: str | None = None) -> dict[str, Any]:
    session = bridge_session_id(user_id, username=username)
    base_url = _base_url(user_id=user_id, username=username)
    with httpx.Client(timeout=_QR_TIMEOUT) as client:
        resp = client.get(
            f"{base_url}/qr",
            params={"session": session},
            headers=_headers(),
        )
        if resp.status_code == 404:
            body: dict[str, Any] = {}
            try:
                parsed = resp.json()
                if isinstance(parsed, dict):
                    body = parsed
            except Exception:  # noqa: BLE001
                pass
            body.setdefault("session", session)
            err = str(body.get("error") or "").lower()
            if "connected" in err or body.get("status") == "connected":
                return _normalize_status({**body, "status": "connected", "qr": None})
            return {**body, "session": session, "connected": False, "qr": None}
        resp.raise_for_status()
        if _response_is_png(resp):
            return _png_qr_payload(session, resp.content)
        try:
            data = resp.json()
        except Exception:  # noqa: BLE001
            if resp.content:
                return _png_qr_payload(session, resp.content)
            return {"session": session, "connected": False, "qr": None}
        if isinstance(data, dict):
            data.setdefault("session", session)
            qr_val = data.get("qr") or data.get("qrDataUrl") or data.get("dataUrl")
            if isinstance(qr_val, str) and qr_val and not str(qr_val).startswith("data:"):
                if qr_val.startswith("iVBOR") or qr_val.startswith("/9j"):
                    data["qrDataUrl"] = f"data:image/png;base64,{qr_val}"
            return _normalize_status(data)
        return {"session": session, "connected": False, "qr": None}


def bridge_pair(
    user_id: int, username: str | None = None, *, force_new: bool = False
) -> dict[str, Any]:
    """Start or restore a QR session on this user's dedicated bridge only.

    force_new=True wipes ONLY this user's session folder on their bridge container.
    Other users on other Railway projects are never touched.
    """
    session = bridge_session_id(user_id, username=username)
    base_url = _base_url(user_id=user_id, username=username)
    with httpx.Client(timeout=_PAIR_TIMEOUT) as client:
        resp = client.post(
            f"{base_url}/pair",
            json={
                "session": session,
                "sessionId": session,
                "forceNew": bool(force_new),
                "force": bool(force_new),
            },
            headers=_headers(),
        )
        resp.raise_for_status()
        if _response_is_png(resp):
            return _png_qr_payload(session, resp.content)
        data = resp.json() if resp.content else {}
        if not isinstance(data, dict):
            data = {"session": session, "connected": False, "qr": None}
        data.setdefault("session", session)
        qr_val = data.get("qr") or data.get("qrDataUrl") or data.get("dataUrl")
        if isinstance(qr_val, str) and qr_val and not str(qr_val).startswith("data:"):
            if qr_val.startswith("iVBOR") or qr_val.startswith("/9j"):
                data["qrDataUrl"] = f"data:image/png;base64,{qr_val}"
        return _normalize_status(data)


def bridge_disconnect(user_id: int, username: str | None = None) -> dict[str, Any]:
    session = bridge_session_id(user_id, username=username)
    base_url = _base_url(user_id=user_id, username=username)
    try:
        with httpx.Client(timeout=_DISCONNECT_TIMEOUT) as client:
            client.post(
                f"{base_url}/disconnect",
                json={"session": session, "sessionId": session},
                headers=_headers(),
            )
            try:
                client.post(
                    f"{base_url}/logout",
                    json={"session": session, "sessionId": session},
                    headers=_headers(),
                )
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass
    disconnected = {"ok": True, "session": session, "connected": False, "status": "disconnected"}
    invalidate_status_cache(user_id)
    return disconnected


def bridge_send(user_id: int, *, to_phone: str, message: str, username: str | None = None) -> dict[str, Any]:
    session = bridge_session_id(user_id, username=username)
    base_url = _base_url(user_id=user_id, username=username)
    phone = (to_phone or "").strip()
    text = (message or "").strip()
    if not phone:
        raise ValueError("Recipient phone is required")
    if not text:
        raise ValueError("Message body is required")
    payload = {
        "session": session,
        "sessionId": session,
        "to": phone,
        "phone": phone,
        "message": text,
        "text": text,
    }
    with httpx.Client(timeout=_SEND_TIMEOUT) as client:
        resp = client.post(
            f"{base_url}/send",
            json=payload,
            headers=_headers(),
        )
        if resp.status_code >= 400:
            detail = resp.text[:300]
            raise RuntimeError(detail or f"Bridge send failed ({resp.status_code})")
        return resp.json() if resp.content else {"status": "sent"}
