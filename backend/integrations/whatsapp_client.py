"""WhatsApp Cloud API client (Meta Graph API) — text/template sends + webhook verification.

Setup reference: developers.facebook.com/docs/whatsapp/cloud-api. Requires:
  WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID,
  WHATSAPP_APP_SECRET, WHATSAPP_WEBHOOK_VERIFY_TOKEN (see backend/.env.example).
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any

import httpx

from config import settings
from integrations.voice_client import normalize_e164


_CLOUD_SEND_PAUSED_MESSAGE = (
    "Meta Cloud WhatsApp sending is PAUSED on Sales Agent "
    "(WHATSAPP_CLOUD_SENDING_ENABLED=false). "
    "No template/text is sent to Meta until billing on Essence WABA is fixed "
    "and sending is re-enabled. WhatsApp Mobile (QR) is unaffected."
)


class WhatsAppClient:
    @property
    def is_configured(self) -> bool:
        return bool(settings.whatsapp_access_token and settings.whatsapp_phone_number_id)

    @property
    def sending_enabled(self) -> bool:
        """Outbound Cloud API templates/text — independent of inbound webhooks/sync."""
        return bool(getattr(settings, "whatsapp_cloud_sending_enabled", False))

    @property
    def webhook_configured(self) -> bool:
        return bool(settings.whatsapp_webhook_verify_token)

    def _base_url(self) -> str:
        version = settings.whatsapp_api_version or "v21.0"
        return f"https://graph.facebook.com/{version}"

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {settings.whatsapp_access_token}",
            "Content-Type": "application/json",
        }

    def _blocked_if_sending_disabled(self) -> dict[str, Any] | None:
        if self.sending_enabled:
            return None
        return {
            "status": "error",
            "message": _CLOUD_SEND_PAUSED_MESSAGE,
            "paused": True,
        }

    def _post(
        self, path: str, payload: dict[str, Any], *, expect_message_id: bool = True
    ) -> dict[str, Any]:
        # Hard stop: never hit Meta Graph for customer messages while paused.
        if expect_message_id:
            blocked = self._blocked_if_sending_disabled()
            if blocked:
                return blocked
        url = f"{self._base_url()}/{path}"
        try:
            response = httpx.post(url, headers=self._headers(), json=payload, timeout=30.0)
        except Exception as exc:  # noqa: BLE001
            return {"status": "error", "message": f"WhatsApp request failed: {exc}"}

        try:
            body = response.json()
        except Exception:  # noqa: BLE001
            body = {}

        if response.status_code == 200:
            if not expect_message_id:
                # mark_read / status updates return {"success": true}, not a wamid
                if body.get("success") is False:
                    return {
                        "status": "error",
                        "message": "WhatsApp API rejected the status update",
                        "raw": body,
                    }
                return {"status": "ok", "message": "OK", "raw": body}

            messages = body.get("messages") or []
            message_id = messages[0].get("id") if messages else None
            if not message_id:
                return {
                    "status": "error",
                    "message": (
                        "WhatsApp API returned OK but no message id — message was not accepted. "
                        "Check WHATSAPP_PHONE_NUMBER_ID and that the template/language are approved."
                    ),
                    "raw": body,
                }
            return {
                "status": "sent",
                "message": "Message accepted by WhatsApp Cloud API (delivery status updates via webhook)",
                "provider_message_id": message_id,
                "raw": body,
            }

        detail = ((body.get("error") or {}).get("message")) or response.text
        return {
            "status": "error",
            "message": _friendly_whatsapp_api_error(response.status_code, detail, body),
            "raw": body,
        }

    def send_text(
        self,
        *,
        phone: str,
        message: str,
        context_message_id: str | None = None,
    ) -> dict[str, Any]:
        """Free-form text — only deliverable within the 24h customer service window."""
        blocked = self._blocked_if_sending_disabled()
        if blocked:
            return blocked
        if not self.is_configured:
            return {
                "status": "not_configured",
                "message": "WhatsApp Cloud API is not configured. Set WHATSAPP_ACCESS_TOKEN "
                "and WHATSAPP_PHONE_NUMBER_ID in backend/.env",
            }
        to = normalize_e164(phone)
        if not to:
            # Meta wa_id is often digits-only already.
            digits = "".join(ch for ch in (phone or "") if ch.isdigit())
            to = f"+{digits}" if digits else None
        if not to:
            return {"status": "error", "message": f"Invalid WhatsApp number: {phone!r}"}

        payload: dict[str, Any] = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to.lstrip("+"),
            "type": "text",
            "text": {"body": message, "preview_url": False},
        }
        # Quote the customer's last inbound wamid — ties the reply to that conversation.
        ctx = (context_message_id or "").strip()
        if ctx.startswith("wamid"):
            payload["context"] = {"message_id": ctx}
        return self._post(f"{settings.whatsapp_phone_number_id}/messages", payload)

    def send_template(
        self,
        *,
        phone: str,
        template_name: str,
        language: str = "en_US",
        components: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Approved template message — required outside the 24h session window, or for any
        business-initiated bulk/marketing send."""
        blocked = self._blocked_if_sending_disabled()
        if blocked:
            return blocked
        if not self.is_configured:
            return {
                "status": "not_configured",
                "message": "WhatsApp Cloud API is not configured. Set WHATSAPP_ACCESS_TOKEN "
                "and WHATSAPP_PHONE_NUMBER_ID in backend/.env",
            }
        to = normalize_e164(phone)
        if not to:
            return {"status": "error", "message": f"Invalid WhatsApp number: {phone!r}"}

        template: dict[str, Any] = {
            "name": template_name,
            "language": {"code": language},
        }
        if components:
            template["components"] = components

        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to.lstrip("+"),
            "type": "template",
            "template": template,
        }
        return self._post(f"{settings.whatsapp_phone_number_id}/messages", payload)

    def create_message_template(
        self,
        *,
        name: str,
        language: str,
        category: str,
        components: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Submit a new message template to Meta for review (returns PENDING until approved)."""
        if not settings.whatsapp_access_token or not settings.whatsapp_business_account_id:
            return {
                "status": "not_configured",
                "message": "Set WHATSAPP_BUSINESS_ACCOUNT_ID and WHATSAPP_ACCESS_TOKEN "
                "in backend/.env to submit templates.",
            }
        payload = {
            "name": name,
            "language": language,
            "category": (category or "UTILITY").upper(),
            "components": components,
        }
        path = f"{settings.whatsapp_business_account_id}/message_templates"
        url = f"{self._base_url()}/{path}"
        try:
            response = httpx.post(url, headers=self._headers(), json=payload, timeout=30.0)
        except Exception as exc:  # noqa: BLE001
            return {"status": "error", "message": f"WhatsApp template submit failed: {exc}"}

        try:
            body = response.json()
        except Exception:  # noqa: BLE001
            body = {}

        if response.status_code in {200, 201}:
            return {
                "status": "submitted",
                "message": "Template submitted to Meta for review",
                "meta_template_id": str(body.get("id") or ""),
                "meta_status": (body.get("status") or "PENDING"),
                "raw": body,
            }

        detail = ((body.get("error") or {}).get("message")) or response.text
        friendly = _friendly_whatsapp_api_error(response.status_code, detail, body)
        return {
            "status": "error",
            "message": friendly,
            "raw": body,
        }

    def verify_api_access(self) -> dict[str, Any]:
        """Lightweight check that the Meta token and phone number id are valid.

        Avoid listing every message template here — that Meta call is slow and can
        starve Railway workers while a send is in flight (causing gateway 502s).
        """
        if not self.is_configured:
            return {
                "ok": False,
                "message": "WhatsApp Cloud API is not configured.",
            }
        url = (
            f"{self._base_url()}/{settings.whatsapp_phone_number_id}"
            "?fields=display_phone_number,verified_name,quality_rating"
        )
        try:
            response = httpx.get(url, headers=self._headers(), timeout=12.0)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "message": f"Could not reach Meta WhatsApp API: {exc}"}
        try:
            body = response.json()
        except Exception:  # noqa: BLE001
            body = {}
        if response.status_code != 200:
            detail = ((body.get("error") or {}).get("message")) or response.text
            return {
                "ok": False,
                "message": _friendly_whatsapp_api_error(response.status_code, detail, body),
            }
        display = body.get("display_phone_number") or body.get("verified_name") or "connected"
        return {
            "ok": True,
            "message": f"Connected to Meta ({display}).",
        }

    def send_approved(
        self,
        *,
        phone: str,
        message: str,
        template_name: str | None = None,
        template_language: str = "en_US",
        template_components: list[dict[str, Any]] | None = None,
        within_session_window: bool = False,
        context_message_id: str | None = None,
    ) -> dict[str, Any]:
        """Dispatch for an approved draft — free text if inside the session window and no
        template was specified, otherwise an approved template is required."""
        if template_name:
            return self.send_template(
                phone=phone,
                template_name=template_name,
                language=template_language,
                components=template_components,
            )
        if within_session_window:
            return self.send_text(
                phone=phone,
                message=message,
                context_message_id=context_message_id,
            )
        return {
            "status": "error",
            "message": (
                "Outside the 24h customer-service window — select an approved template "
                "to send this WhatsApp message."
            ),
        }

    def mark_read(self, message_id: str) -> dict[str, Any]:
        if not self.is_configured or not message_id:
            return {"status": "skipped"}
        payload = {
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": message_id,
        }
        return self._post(
            f"{settings.whatsapp_phone_number_id}/messages",
            payload,
            expect_message_id=False,
        )

    def list_templates(self) -> dict[str, Any]:
        """Pull message templates from the WABA (for syncing into whatsapp_templates)."""
        if not settings.whatsapp_access_token or not settings.whatsapp_business_account_id:
            return {
                "status": "not_configured",
                "message": "Set WHATSAPP_BUSINESS_ACCOUNT_ID and WHATSAPP_ACCESS_TOKEN "
                "in backend/.env to sync templates.",
                "templates": [],
            }
        url = (
            f"{self._base_url()}/{settings.whatsapp_business_account_id}/message_templates"
            "?fields=name,category,language,status,components&limit=200"
        )
        try:
            response = httpx.get(url, headers=self._headers(), timeout=30.0)
        except Exception as exc:  # noqa: BLE001
            return {"status": "error", "message": f"Template fetch failed: {exc}", "templates": []}

        try:
            body = response.json()
        except Exception:  # noqa: BLE001
            body = {}

        if response.status_code != 200:
            detail = ((body.get("error") or {}).get("message")) or response.text
            return {
                "status": "error",
                "message": _friendly_whatsapp_api_error(response.status_code, detail, body),
                "templates": [],
            }

        return {"status": "ok", "templates": body.get("data") or []}

    def delete_message_template(
        self,
        *,
        name: str,
        hsm_id: str | None = None,
    ) -> dict[str, Any]:
        """Delete a message template on the WABA (by template id when known, else by name)."""
        if not settings.whatsapp_access_token or not settings.whatsapp_business_account_id:
            return {
                "status": "not_configured",
                "message": "Set WHATSAPP_BUSINESS_ACCOUNT_ID and WHATSAPP_ACCESS_TOKEN "
                "in backend/.env to delete templates on Meta.",
            }
        params: dict[str, str] = {}
        if hsm_id:
            params["hsm_id"] = str(hsm_id)
        elif name:
            params["name"] = name
        else:
            return {"status": "error", "message": "Template name or Meta template id is required"}

        url = f"{self._base_url()}/{settings.whatsapp_business_account_id}/message_templates"
        try:
            response = httpx.delete(url, headers=self._headers(), params=params, timeout=30.0)
        except Exception as exc:  # noqa: BLE001
            return {"status": "error", "message": f"WhatsApp template delete failed: {exc}"}

        try:
            body = response.json()
        except Exception:  # noqa: BLE001
            body = {}

        if response.status_code in {200, 201} or body.get("success") is True:
            return {
                "status": "deleted",
                "message": "Template deleted on Meta",
                "raw": body,
            }

        detail = ((body.get("error") or {}).get("message")) or response.text or ""
        lower = str(detail).lower()
        code = ((body.get("error") or {}).get("code"))
        already_gone = (
            response.status_code == 404
            or code == 33
            or "does not exist" in lower
            or "could not be found" in lower
            or "not found" in lower
        )
        if already_gone:
            return {
                "status": "already_gone",
                "message": detail or "Template was already deleted on Meta",
                "raw": body,
            }

        friendly = _friendly_whatsapp_api_error(response.status_code, str(detail), body)
        return {"status": "error", "message": friendly, "raw": body}

    def verify_webhook_signature(self, *, payload: bytes, signature_header: str | None) -> bool:
        """Validate X-Hub-Signature-256 using the Meta app secret."""
        if not settings.whatsapp_validate_webhooks:
            return True
        if not settings.whatsapp_app_secret:
            # No app secret configured — cannot verify; caller should treat as unverified.
            return False
        if not signature_header or not signature_header.startswith("sha256="):
            return False
        expected = hmac.new(
            settings.whatsapp_app_secret.encode("utf-8"), payload, hashlib.sha256
        ).hexdigest()
        provided = signature_header.split("=", 1)[1]
        return hmac.compare_digest(expected, provided)


whatsapp_client = WhatsAppClient()


def _friendly_whatsapp_api_error(
    status_code: int, detail: str, body: dict[str, Any] | None = None
) -> str:
    """Turn Meta Graph API errors into actionable dashboard messages."""
    text = (detail or "").strip()
    lower = text.lower()
    error_obj = (body or {}).get("error") or {}
    code = error_obj.get("code")

    if code in {131026, 131051} or "not a valid whatsapp user" in lower or "not on whatsapp" in lower or "undeliverable" in lower or "not registered" in lower:
        return f"Recipient number is not registered on WhatsApp. ({text})"
    if code in {131047, 131048} or "re-engagement" in lower or "24 hour" in lower or "experimental" in lower:
        return (
            "Outside the 24h customer-service window — Meta blocked free-text. "
            "Send an approved template, or wait until the customer messages you first."
        )
    if code == 132012 or ("parameter format" in lower) or ("format mismatch" in lower):
        return (
            "Template parameter mismatch — Meta expected a different header/body format "
            "(often an IMAGE header or wrong variable count). Re-sync the template, then "
            f"retry. ({text})"
        )
    if code == 132000 or ("number of parameters" in lower):
        return f"Template parameter mismatch — check variable count/order. ({text})"
    if code in {132001, 132005, 132007, 132015} or "template" in lower and (
        "does not exist" in lower or "paused" in lower or "disabled" in lower or "not approved" in lower
    ):
        return (
            f"Template rejected by Meta (not approved / paused / wrong language). ({text})"
        )
    if status_code == 401 or code == 190 or "expired" in lower or "session has expired" in lower:
        return (
            "Your WHATSAPP_ACCESS_TOKEN has expired. In Meta Business Settings → System users, "
            "generate a new permanent token with whatsapp_business_management, update "
            "backend/.env, then restart the backend."
        )
    if status_code == 403 or "permission" in lower:
        return (
            f"Meta rejected the request (permissions): {text or 'missing whatsapp_business_management scope'}"
        )
    if text:
        return f"WhatsApp API {status_code}: {text}"
    return f"WhatsApp API error {status_code}"
