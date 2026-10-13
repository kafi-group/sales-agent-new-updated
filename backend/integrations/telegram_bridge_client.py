"""HTTP client for Telegram Mobile bridge (user-account login, not Bot API)."""

from __future__ import annotations

from typing import Any

import httpx

from config import settings

_STATUS_TIMEOUT = 8.0
_LOGIN_TIMEOUT = 30.0
_SEND_TIMEOUT = 20.0


def bridge_session_id(user_id: int, username: str | None = None) -> str:
    prefix = (settings.telegram_bridge_session_prefix or "kafi-telegram").strip()
    clean_name = (username or "").strip().lower()
    if clean_name:
        return f"{prefix}-{clean_name}"
    return f"{prefix}-u{int(user_id)}"


def _headers() -> dict[str, str]:
    secret = (settings.telegram_bridge_secret or "").strip()
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if secret:
        headers["x-bridge-secret"] = secret
    return headers


def _base_url() -> str:
    return (settings.telegram_bridge_url or "").strip().rstrip("/")


def bridge_configured() -> bool:
    return bool(_base_url())


def _request(
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
    timeout: float = _STATUS_TIMEOUT,
) -> dict[str, Any]:
    base = _base_url()
    if not base:
        raise RuntimeError(
            "Telegram bridge is not configured. Set TELEGRAM_BRIDGE_URL on the Sales Agent backend "
            "and deploy telegram_bridge with TELEGRAM_API_ID / TELEGRAM_API_HASH."
        )
    url = f"{base}{path}"
    with httpx.Client(timeout=timeout) as client:
        res = client.request(method, url, headers=_headers(), json=json_body, params=params)
        data: dict[str, Any]
        try:
            data = res.json()
        except Exception:
            data = {"error": (res.text or res.reason_phrase)[:400]}
        if res.status_code >= 400:
            raw = str(data.get("error") or data.get("detail") or res.text or res.status_code)
            if res.status_code == 404 or "Cannot POST /start-qr-login" in raw or "Cannot POST /poll-qr-login" in raw:
                raise RuntimeError(
                    "Telegram bridge is outdated (missing QR login routes). "
                    "Redeploy the telegram_bridge service on Railway with the latest code, "
                    "and set TELEGRAM_API_ID / TELEGRAM_API_HASH on that service."
                )
            raise RuntimeError(raw)
        return data if isinstance(data, dict) else {"ok": True}


def get_status(session_id: str) -> dict[str, Any]:
    return _request("GET", "/status", params={"sessionId": session_id}, timeout=_STATUS_TIMEOUT)


def start_login(session_id: str, phone: str) -> dict[str, Any]:
    return _request(
        "POST",
        "/start-login",
        json_body={"sessionId": session_id, "phone": phone},
        timeout=_LOGIN_TIMEOUT,
    )


def start_qr_login(session_id: str) -> dict[str, Any]:
    return _request(
        "POST",
        "/start-qr-login",
        json_body={"sessionId": session_id},
        timeout=_LOGIN_TIMEOUT,
    )


def poll_qr_login(session_id: str) -> dict[str, Any]:
    return _request(
        "POST",
        "/poll-qr-login",
        json_body={"sessionId": session_id},
        timeout=_LOGIN_TIMEOUT,
    )


def confirm_code(session_id: str, code: str) -> dict[str, Any]:
    return _request(
        "POST",
        "/confirm-code",
        json_body={"sessionId": session_id, "code": code},
        timeout=_LOGIN_TIMEOUT,
    )


def confirm_password(session_id: str, password: str) -> dict[str, Any]:
    return _request(
        "POST",
        "/confirm-password",
        json_body={"sessionId": session_id, "password": password},
        timeout=_LOGIN_TIMEOUT,
    )


def disconnect(session_id: str) -> dict[str, Any]:
    return _request(
        "POST",
        "/disconnect",
        json_body={"sessionId": session_id},
        timeout=_STATUS_TIMEOUT,
    )


def send_message(session_id: str, to: str, text: str) -> dict[str, Any]:
    return _request(
        "POST",
        "/send",
        json_body={"sessionId": session_id, "to": to, "text": text},
        timeout=_SEND_TIMEOUT,
    )
