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
    """Namespace sessions so each user's bridge container has a clean session.

    Username keeps ``kafi-sales-agent-<username>``. With no username the id is
    ``kafi-sales-agent-u<id>``. Never returns an empty session.
    """
    prefix = (settings.whatsapp_bridge_session_prefix or "kafi-sales-agent").strip() or "kafi-sales-agent"
    clean_name = (username or "").strip().lower()
    if clean_name:
        session = f"{prefix}-{clean_name}"
    else:
        session = f"{prefix}-u{int(user_id)}"
    session = session.strip()
    if not session:
        return f"kafi-sales-agent-u{int(user_id)}"
    return session


def _headers() -> dict[str, str]:
    secret = (settings.whatsapp_bridge_secret or "4ce746274829595960813f40c4ee4c355b351b5ee41fc83f").strip()
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if secret:
        headers["x-bridge-secret"] = secret
    return headers


# Keep QR/bridge calls short so a disconnect cannot starve email, Cloud inbox, or leads.
_STATUS_TIMEOUT = 4.0
# Bridge waits up to ~28s for a finished PNG. These must outlast that wait.
# Bridge waitForQrOrConnected runs up to 45s — client timeouts must exceed that.
_QR_TIMEOUT = 52.0
_PAIR_TIMEOUT = 55.0
_DISCONNECT_TIMEOUT = 5.0
_SEND_TIMEOUT = 30.0
_SEND_DOCUMENT_TIMEOUT = 55.0


def _first_url(*candidates: str | None) -> str:
    for raw in candidates:
        val = (raw or "").strip().rstrip("/")
        if val:
            return val
    return ""


def _base_url(user_id: int | None = None, username: str | None = None) -> str:
    """Resolve the WhatsApp bridge for this Sales Agent login.

    Khalid, Asim, Usman, and Sadia use their per-user URL, then the hardcoded
    dedicated host. WHATSAPP_BRIDGE_URL is only for a login with no dedicated
    bridge. Unknown users never fall through to Khalid's host.
    """
    owner = bridge_owner_key(username, user_id)
    clean_name = (username or "").strip().lower()
    general = _first_url(settings.whatsapp_bridge_url)

    if owner == "khalid":
        custom = _first_url(settings.whatsapp_bridge_url_khalid, settings.whatsapp_bridge_url_admin)
        return custom or DEFAULT_USER_BRIDGES["khalid"]
    if owner == "asim":
        custom = _first_url(settings.whatsapp_bridge_url_asim)
        return custom or DEFAULT_USER_BRIDGES["asim"]
    if owner == "usman":
        custom = _first_url(settings.whatsapp_bridge_url_usman)
        return custom or DEFAULT_USER_BRIDGES["usman"]
    if owner == "sadia":
        custom = _first_url(settings.whatsapp_bridge_url_sadia)
        return custom or DEFAULT_USER_BRIDGES["sadia"]

    if clean_name and clean_name in DEFAULT_USER_BRIDGES:
        return DEFAULT_USER_BRIDGES[clean_name]
    if user_id is not None and user_id in DEFAULT_USER_ID_BRIDGES:
        return DEFAULT_USER_ID_BRIDGES[user_id]

    return general


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


def _qr_image_url(data: dict[str, Any]) -> str | None:
    """Return a real image data URL. Ignore the raw Baileys pairing string."""
    for key in ("qrDataUrl", "dataUrl", "qr"):
        val = data.get(key)
        if not isinstance(val, str):
            continue
        text = val.strip()
        if text.startswith("data:image/"):
            return text
        if text.startswith("iVBOR"):
            return f"data:image/png;base64,{text}"
        if text.startswith("/9j"):
            return f"data:image/jpeg;base64,{text}"
    return None


def publish_qr_fields(data: dict[str, Any]) -> dict[str, Any]:
    """Strip the pairing text so the UI cannot draw it as a half-rendered PNG."""
    data["qrDataUrl"] = _qr_image_url(data)
    data["qr"] = None
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


def _status_when_bridge_unreachable(user_id: int, session: str) -> dict[str, Any]:
    """Last good snapshot, or unreachable. Never written back into the cache."""
    cached = last_cached_status(user_id)
    if cached is not None:
        return cached
    return {"connected": False, "session": session, "status": "unreachable"}


def bridge_status(user_id: int, username: str | None = None) -> dict[str, Any]:
    session = bridge_session_id(user_id, username=username).strip()
    if not session:
        return {"connected": False, "session": "", "status": "unreachable"}
    base_url = _base_url(user_id=user_id, username=username)
    if not base_url:
        return _status_when_bridge_unreachable(user_id, session)
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
            normalized = publish_qr_fields(_normalize_status(data))
            pending = str(normalized.get("status") or "").lower() in {"qr-pending", "connecting"}
            if pending and not _qr_image_url(normalized):
                try:
                    qr_resp = client.get(
                        f"{base_url}/qr",
                        params={"session": session},
                        headers=_headers(),
                        timeout=_QR_TIMEOUT,
                    )
                    if qr_resp.status_code == 200:
                        if _response_is_png(qr_resp):
                            normalized.update(_png_qr_payload(session, qr_resp.content))
                        else:
                            qr_data = qr_resp.json() if qr_resp.content else {}
                            if isinstance(qr_data, dict):
                                merged = publish_qr_fields(
                                    _normalize_status({**qr_data, "session": session})
                                )
                                if _qr_image_url(merged):
                                    normalized.update(merged)
                except Exception:  # noqa: BLE001
                    pass
            _store_status_cache(user_id, normalized)
            return normalized
    except httpx.TransportError:
        # Timeout and network failures must not paint the last good link as logged out.
        return _status_when_bridge_unreachable(user_id, session)
    except Exception:  # noqa: BLE001
        return {"connected": False, "session": session, "status": "disconnected"}


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


def last_cached_status(user_id: int) -> dict[str, Any] | None:
    """Last stored status snapshot for this user, even after the TTL has passed."""
    with _status_cache_lock:
        hit = _status_cache.get(int(user_id))
        if not hit:
            return None
        return dict(hit[1])


def invalidate_status_cache(user_id: int | None = None) -> None:
    with _status_cache_lock:
        if user_id is None:
            _status_cache.clear()
        else:
            _status_cache.pop(int(user_id), None)


def _unreachable(base_url: str) -> RuntimeError:
    return RuntimeError(
        f"WhatsApp bridge is not reachable at {base_url}. "
        "Start the WhatsApp Mobile bridge, then tap Generate QR Code again."
    )


def bridge_qr(user_id: int, username: str | None = None) -> dict[str, Any]:
    session = bridge_session_id(user_id, username=username)
    base_url = _base_url(user_id=user_id, username=username)
    try:
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
                # Railway HTML 404 for a missing service is not a "QR not ready" payload.
                if not body.get("status") and not body.get("error"):
                    raise _unreachable(base_url)
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
                return publish_qr_fields(_normalize_status(data))
            return {"session": session, "connected": False, "qr": None, "qrDataUrl": None}
    except RuntimeError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _unreachable(base_url) from exc


def bridge_pair(
    user_id: int, username: str | None = None, *, force_new: bool = False
) -> dict[str, Any]:
    """Start or restore a QR session on this user's dedicated bridge only.

    force_new=True wipes ONLY this user's session folder on their bridge container.
    Other users on other Railway projects are never touched.
    """
    session = bridge_session_id(user_id, username=username)
    base_url = _base_url(user_id=user_id, username=username)
    invalidate_status_cache(user_id)
    try:
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
                out = _png_qr_payload(session, resp.content)
                _store_status_cache(user_id, out)
                return out
            data = resp.json() if resp.content else {}
            if not isinstance(data, dict):
                data = {"session": session, "connected": False, "qr": None}
            data.setdefault("session", session)
            qr_val = data.get("qr") or data.get("qrDataUrl") or data.get("dataUrl")
            if isinstance(qr_val, str) and qr_val and not str(qr_val).startswith("data:"):
                if qr_val.startswith("iVBOR") or qr_val.startswith("/9j"):
                    data["qrDataUrl"] = f"data:image/png;base64,{qr_val}"
            out = publish_qr_fields(_normalize_status(data))
            if not _qr_image_url(out) and not out.get("connected"):
                try:
                    qr_resp = client.get(
                        f"{base_url}/qr",
                        params={"session": session},
                        headers=_headers(),
                        timeout=_QR_TIMEOUT,
                    )
                    if qr_resp.status_code == 200:
                        if _response_is_png(qr_resp):
                            out.update(_png_qr_payload(session, qr_resp.content))
                        else:
                            qr_data = qr_resp.json() if qr_resp.content else {}
                            if isinstance(qr_data, dict):
                                merged = publish_qr_fields(
                                    _normalize_status({**qr_data, "session": session})
                                )
                                if _qr_image_url(merged):
                                    out.update(merged)
                except Exception:  # noqa: BLE001
                    pass
            _store_status_cache(user_id, out)
            return out
    except Exception as exc:  # noqa: BLE001
        raise _unreachable(base_url) from exc


def bridge_disconnect(user_id: int, username: str | None = None) -> dict[str, Any]:
    """Disconnect this session once. /logout would stop the same session again."""
    session = bridge_session_id(user_id, username=username).strip()
    base_url = _base_url(user_id=user_id, username=username)
    if session and base_url:
        try:
            with httpx.Client(timeout=_DISCONNECT_TIMEOUT) as client:
                client.post(
                    f"{base_url}/disconnect",
                    json={"session": session, "sessionId": session},
                    headers=_headers(),
                )
        except Exception:  # noqa: BLE001
            pass
    disconnected = {"ok": True, "session": session, "connected": False, "status": "disconnected"}
    invalidate_status_cache(user_id)
    return disconnected


def _bridge_error_text(resp: httpx.Response) -> str:
    detail = ""
    try:
        body = resp.json()
        if isinstance(body, dict):
            detail = str(body.get("error") or body.get("detail") or "").strip()
    except Exception:  # noqa: BLE001
        detail = ""
    if not detail:
        detail = (resp.text or "").strip()[:400]
    return detail or f"WhatsApp send failed ({resp.status_code})"


def bridge_send(
    user_id: int,
    *,
    to_phone: str,
    message: str,
    username: str | None = None,
    document_url: str | None = None,
    filename: str | None = None,
) -> dict[str, Any]:
    session = bridge_session_id(user_id, username=username)
    base_url = _base_url(user_id=user_id, username=username)
    phone = (to_phone or "").strip()
    text = (message or "").strip()
    doc_url = (document_url or "").strip()
    if not phone:
        raise ValueError("Recipient phone is required")
    if not text and not doc_url:
        raise ValueError("Message body is required")
    payload: dict[str, Any] = {
        "session": session,
        "sessionId": session,
        "to": phone,
        "phone": phone,
        "message": text,
        "text": text,
    }
    if doc_url:
        payload["document_url"] = doc_url
        payload["filename"] = (filename or "catalogue.pdf").strip() or "catalogue.pdf"
        payload["mimetype"] = "application/pdf"
    timeout = _SEND_DOCUMENT_TIMEOUT if doc_url else _SEND_TIMEOUT
    with httpx.Client(timeout=timeout) as client:
        resp = client.post(
            f"{base_url}/send",
            json=payload,
            headers=_headers(),
        )
        if resp.status_code >= 400:
            raise RuntimeError(_bridge_error_text(resp))
        data = resp.json() if resp.content else {"status": "sent"}
        if isinstance(data, dict) and data.get("delivered") is False:
            raise RuntimeError(str(data.get("error") or "WhatsApp did not confirm delivery."))
        return data if isinstance(data, dict) else {"status": "sent"}
