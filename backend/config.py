from pathlib import Path

from pydantic import ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "postgresql://postgres:postgres@localhost:5432/kafi_sales_agent"
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    api_debug: bool = True
    cors_origins: str = (
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://localhost:5174,http://127.0.0.1:5174,"
        "http://localhost:5175,http://127.0.0.1:5175,"
        "https://kafi-sales-agent.vercel.app,"
        "https://sales-agent-new-updated.vercel.app"
    )

    serpapi_api_key: str | None = None
    # Optional comma-separated extra keys. When the active key hits monthly/hourly
    # limits, web_search rotates to the next key and later returns to the first
    # once account.json reports searches left again.
    serpapi_api_keys: str | None = None
    gmail_client_id: str | None = None
    gmail_client_secret: str | None = None
    gmail_refresh_token: str | None = None
    gmail_sender_email: str | None = None
    # Only show inbox mail on/after this date (YYYY-MM-DD). If unset, auto-set to connect day.
    inbox_since: str | None = None
    gmail_inbox_since: str | None = None  # legacy alias — use INBOX_SINCE instead

    # Outlook shared inbox via IMAP (receive) + Microsoft Graph Mail.Send (send).
    # SMTP is often disabled on personal @outlook.com (5.7.139) — do not rely on it.
    # Set MAILBOX_ENABLED=true when ready to use Inbox / Approve & Send.
    mailbox_enabled: bool = False
    mailbox_imap_host: str = "outlook.office365.com"
    mailbox_imap_port: int = 993
    mailbox_smtp_host: str = "smtp.office365.com"
    mailbox_smtp_port: int = 587
    # When IMAP/SMTP hosts are a raw IP (Cloudflare bypass), validate the TLS
    # certificate against this hostname (e.g. mail.kafi-group.com).
    mailbox_ssl_hostname: str | None = None
    # Legacy single-mailbox fallback (prefer per-user credentials on app_users).
    mailbox_email: str | None = None
    mailbox_password: str | None = None
    mailbox_display_name: str | None = None
    # Fernet key for encrypting per-user mailbox passwords (url-safe base64, 32 bytes).
    # Generate: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    mailbox_credentials_key: str | None = None
    # Per-user mailbox credentials (synced onto app_users at startup).
    mailbox_admin_email: str | None = None
    mailbox_admin_password: str | None = None
    mailbox_admin_display_name: str | None = None
    mailbox_asim_email: str | None = None
    mailbox_asim_password: str | None = None
    mailbox_asim_display_name: str | None = None
    mailbox_usman_email: str | None = None
    mailbox_usman_password: str | None = None
    mailbox_usman_display_name: str | None = None
    mailbox_sadia_email: str | None = None
    mailbox_sadia_password: str | None = None
    mailbox_sadia_display_name: str | None = None
    mailbox_finance_email: str | None = None
    mailbox_finance_password: str | None = None
    mailbox_finance_display_name: str | None = None
    # OAuth — required for most Outlook.com accounts (password/IMAP basic auth is blocked).
    mailbox_client_id: str | None = None
    mailbox_client_secret: str | None = None
    mailbox_refresh_token: str | None = None
    mailbox_tenant_id: str = "consumers"  # personal Outlook/Hotmail; use tenant id for work accounts
    # Public HTTPS API base for email open-tracking pixels (e.g. Railway URL).
    # Falls back to TWILIO_WEBHOOK_BASE_URL when unset.
    public_api_base_url: str | None = None
    email_track_secret: str | None = None  # optional HMAC secret for open tokens

    # Resend HTTPS send (Railway Hobby — SMTP ports are blocked there).
    # Verify kafi-group.com in Resend, then set RESEND_API_KEY. From-address =
    # each user's mailbox email. Leave unset to use SMTP (local / Railway Pro).
    resend_api_key: str | None = None

    # Vercel mailer handoff (SMTP on Vercel, not Railway).
    # Same MAILER_HANDOFF_SECRET must be set on the mailer Vercel project.
    mailer_handoff_secret: str | None = None
    mailer_public_url: str | None = None  # e.g. https://kafi-mailer.vercel.app

    # Gemini LLM (see modules/llm_client.py) — loaded from .env into Settings, not os.environ.
    gemini_api_key: str | None = None
    llm_api_key: str | None = None  # legacy alias for gemini_api_key
    gemini_api_keys: str | None = None  # optional comma-separated extra keys
    gemini_model: str = "gemini-3.1-flash-lite"
    gemini_fallback_models: str | None = None
    gemini_max_output_tokens: int = 512

    # Product chatbot only — separate keys from GEMINI_API_KEY / llm_client.py
    chatbot_gemini_api_key: str | None = None
    chatbot_gemini_api_keys: str | None = None  # optional comma-separated extra keys
    chatbot_gemini_fallback_models: str | None = None
    chatbot_openai_api_key: str | None = None
    chatbot_openai_model: str = "gpt-4o-mini"
    chatbot_anthropic_api_key: str | None = None
    chatbot_anthropic_model: str = "claude-3-5-haiku-20241022"

    # Sales assistant (floating co-pilot) — data Q&A + in-app navigation
    sales_assistant_access_code: str = "07860"
    sales_assistant_gemini_api_key: str | None = None
    sales_assistant_gemini_api_keys: str | None = None  # optional comma-separated extra keys
    sales_assistant_gemini_model: str = "gemini-3.1-flash-lite"
    sales_assistant_gemini_fallback_models: str | None = None
    sales_assistant_gemini_max_output_tokens: int = 1024

    # KPI Generation summaries only — separate key from GEMINI_API_KEY / chatbot
    kpi_gemini_api_key: str | None = None
    kpi_gemini_api_keys: str | None = None  # optional comma-separated extra keys
    kpi_gemini_model: str = "gemini-3.1-flash-lite"
    kpi_gemini_fallback_models: str | None = None
    kpi_gemini_max_output_tokens: int = 1024

    # AI Mode — Company lifecycle query replies (New Lead manual reply)
    ai_mode_query_gemini_api_key: str | None = None
    ai_mode_query_gemini_api_keys: str | None = None  # optional comma-separated extra keys
    ai_mode_query_gemini_model: str = "gemini-3.1-flash-lite"
    ai_mode_query_gemini_fallback_models: str | None = None
    ai_mode_query_gemini_max_output_tokens: int = 512

    # AI Mode — after-hours auto-reply (email + WhatsApp)
    ai_mode_auto_reply_gemini_api_key: str | None = None
    ai_mode_auto_reply_gemini_api_keys: str | None = None  # optional comma-separated extra keys
    ai_mode_auto_reply_gemini_model: str = "gemini-3.1-flash-lite"
    ai_mode_auto_reply_gemini_fallback_models: str | None = None
    ai_mode_auto_reply_gemini_max_output_tokens: int = 1024

    # Email Templates — "Generate with AI" from template title
    email_template_gemini_api_key: str | None = None
    email_template_gemini_api_keys: str | None = None  # optional comma-separated extra keys
    email_template_gemini_model: str = "gemini-3.1-flash-lite"
    email_template_gemini_fallback_models: str | None = None
    email_template_gemini_max_output_tokens: int = 2048

    # SerpAPI for auto-reply company research only (separate from discover-leads SERPAPI_API_KEY)
    ai_mode_auto_reply_serpapi_api_key: str | None = None

    # Web search — see modules/web_search.py
    brave_api_key: str | None = None
    google_cse_api_key: str | None = None
    google_cse_engine_id: str | None = None
    companylens_api_key: str | None = None
    # Fallback chain for market discovery (first provider that returns results).
    # Default: serpapi,duckduckgo,google_cse,wikidata
    web_search_providers: str | None = None
    # Per-record enrichment: ALL listed providers run and results merge.
    # Default: serpapi,duckduckgo,google_cse,wikidata (+ CompanyLens after a domain is found)
    web_search_combined_providers: str | None = None

    # Vapi AI Voice Integration (Sub-Second Ultra-Fast Conversational Voice Engine)
    # Set VAPI_API_KEY / VAPI_PHONE_NUMBER_ID in Railway (or backend/.env locally).
    vapi_api_key: str | None = None
    vapi_phone_number_id: str | None = None
    vapi_enabled: bool = True
    elevenlabs_enabled: bool = False
    elevenlabs_api_key: str | None = "sk_880257fad111679821f7d3bbbf1a562b4d2c2fbe22cd14af"
    # Backup ElevenLabs key (second account) — switch to this when primary quota runs out.
    elevenlabs_api_key_2: str | None = "sk_f22c68ea0d26139c1184f6c515735986fcdca941fee4ba8c"

    # Twilio Voice — browser calling from dashboard (integrations/voice_client.py)
    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_phone_number: str | None = None
    twilio_api_key_sid: str | None = None
    twilio_api_key_secret: str | None = None
    twilio_twiml_app_sid: str | None = None
    # Public HTTPS base URL for Twilio webhooks (e.g. https://your-api.railway.app or ngrok URL)
    twilio_webhook_base_url: str | None = None
    # Validate X-Twilio-Signature on webhooks (default false for reverse-proxy compatibility on Railway/Cloudflare)
    twilio_validate_webhooks: bool = False
    # Hang up unanswered outbound after ring_timeout_seconds, then auto-redial
    # up to max_ring_attempts times (16s → hangup → 16s → …) until answered or cap.
    hangup_after_fourth_ring: bool = True
    ring_timeout_seconds: int = 16
    max_ring_attempts: int = 10

    # Bulk email throttling (Gmail-safe batching)
    bulk_email_batch_size: int = 50
    bulk_email_message_delay_seconds: float = 3.0
    bulk_email_batch_pause_seconds: float = 60.0
    bulk_email_max_per_request: int = 50

    # WhatsApp Cloud API (Meta) — integrations/whatsapp_client.py
    whatsapp_access_token: str | None = None
    whatsapp_phone_number_id: str | None = None
    whatsapp_business_account_id: str | None = None
    whatsapp_app_secret: str | None = None
    # Shared secret you choose and enter into Meta's webhook subscription setup.
    whatsapp_webhook_verify_token: str | None = None
    whatsapp_api_version: str = "v21.0"
    # Verify X-Hub-Signature-256 on webhooks (set false only for local debugging).
    whatsapp_validate_webhooks: bool = True
    # Human-readable business number (E.164), e.g. +923078206633 — not the Phone Number ID.
    whatsapp_display_number: str | None = None
    # Kill switch for Meta Cloud outbound (templates/text). Leave true so only Meta
    # billing/eligibility blocks delivery. Set false only for an emergency stop.
    # Does NOT affect Baileys / WhatsApp Mobile (personal QR) sends.
    whatsapp_cloud_sending_enabled: bool = True
    # Bulk WhatsApp throttling — Meta's messaging tier limits unique conversations/24h.
    bulk_whatsapp_message_delay_seconds: float = 2.0
    bulk_whatsapp_max_per_request: int = 250

    # Baileys personal WhatsApp bridge (per-user QR) — dedicated Railway services per sales rep
    whatsapp_bridge_url: str | None = None
    whatsapp_bridge_url_admin: str | None = None
    whatsapp_bridge_url_khalid: str | None = None
    whatsapp_bridge_url_asim: str | None = None
    whatsapp_bridge_url_usman: str | None = None
    whatsapp_bridge_url_sadia: str | None = None
    whatsapp_bridge_secret: str | None = "4ce746274829595960813f40c4ee4c355b351b5ee41fc83f"
    whatsapp_bridge_session_prefix: str = "kafi-sales-agent"

    # Telegram Mobile bridge (user account via MTProto — not Bot API)
    telegram_bridge_url: str | None = None
    telegram_bridge_secret: str | None = None
    telegram_bridge_session_prefix: str = "kafi-telegram"

    # Read-only dashboard bridge for bank-recon / PA (x-bridge-secret header).
    agent_bridge_secret: str | None = None

    # DB connection pool — sized for concurrent CRM polls + background jobs
    db_pool_size: int = 16
    db_max_overflow: int = 24
    db_pool_timeout: int = 25

    @field_validator("mailbox_imap_port", "mailbox_smtp_port", mode="before")
    @classmethod
    def _empty_port_uses_default(cls, value: object, info: ValidationInfo) -> object:
        if value == "" or value is None:
            return 993 if info.field_name == "mailbox_imap_port" else 587
        return value

    @field_validator(
        "mailbox_email",
        "mailbox_password",
        "mailbox_display_name",
        "mailbox_credentials_key",
        "mailbox_admin_email",
        "mailbox_admin_password",
        "mailbox_admin_display_name",
        "mailbox_asim_email",
        "mailbox_asim_password",
        "mailbox_asim_display_name",
        "mailbox_usman_email",
        "mailbox_usman_password",
        "mailbox_usman_display_name",
        "mailbox_sadia_email",
        "mailbox_sadia_password",
        "mailbox_sadia_display_name",
        "mailbox_finance_email",
        "mailbox_finance_password",
        "mailbox_finance_display_name",
        "mailbox_ssl_hostname",
        "mailbox_client_id",
        "mailbox_client_secret",
        "mailbox_refresh_token",
        "public_api_base_url",
        "email_track_secret",
        mode="before",
    )
    @classmethod
    def _empty_str_to_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
