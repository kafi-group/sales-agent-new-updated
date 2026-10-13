import enum
from datetime import date, datetime
from typing import Optional

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Channel(str, enum.Enum):
    email = "email"
    whatsapp = "whatsapp"
    phone = "phone"
    linkedin = "linkedin"
    facebook = "facebook"
    instagram = "instagram"


class Direction(str, enum.Enum):
    inbound = "inbound"
    outbound = "outbound"


class HandledBy(str, enum.Enum):
    agent = "agent"
    human = "human"


class InteractionStatus(str, enum.Enum):
    draft = "draft"
    approved = "approved"
    sent = "sent"
    rejected = "rejected"


class LeadScoreLabel(str, enum.Enum):
    """Company grade from scoring (replaces HOT/WARM/COLD).

    AAAA = top tier / mega distributor / elite enterprise
    AAA  = large-scale importer
    AA   = solid mid-tier fit
    A    = weak fit / low priority
    """

    AAAA = "AAAA"
    AAA = "AAA"
    AA = "AA"
    A = "A"


class QuotationStatus(str, enum.Enum):
    draft = "draft"
    approved = "approved"
    sent = "sent"
    expired = "expired"


class ExportStatus(str, enum.Enum):
    pending = "pending"
    shipped = "shipped"
    delivered = "delivered"
    cancelled = "cancelled"


class ConsentStatus(str, enum.Enum):
    unknown = "unknown"
    granted = "granted"
    denied = "denied"


class MarketRole(str, enum.Enum):
    consumer = "consumer"
    producer = "producer"
    hybrid = "hybrid"
    unknown = "unknown"


class ProducerTier(str, enum.Enum):
    strong = "strong"
    weak = "weak"


class AppUserRole(str, enum.Enum):
    admin = "admin"
    user = "user"


class EventType(str, enum.Enum):
    birthday = "birthday"
    national_day = "national_day"
    follow_up = "follow_up"
    promotion_congrats = "promotion_congrats"


class ScheduledEventStatus(str, enum.Enum):
    pending = "pending"
    draft_created = "draft_created"
    completed = "completed"
    skipped = "skipped"


class WhatsAppTemplateStatus(str, enum.Enum):
    approved = "approved"
    pending = "pending"
    rejected = "rejected"
    paused = "paused"
    disabled = "disabled"


class Buyer(Base):
    __tablename__ = "buyers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    website_url: Mapped[Optional[str]] = mapped_column(String(512))
    country: Mapped[Optional[str]] = mapped_column(String(100), index=True)
    industry: Mapped[Optional[str]] = mapped_column(String(255))
    linkedin_company_url: Mapped[Optional[str]] = mapped_column(String(512))
    facebook_company_url: Mapped[Optional[str]] = mapped_column(String(512))
    instagram_company_url: Mapped[Optional[str]] = mapped_column(String(512))
    source: Mapped[Optional[str]] = mapped_column(String(100), index=True)
    legacy_serial_no: Mapped[Optional[int]] = mapped_column(Integer)
    company_grading: Mapped[Optional[str]] = mapped_column(String(50))
    product_interest: Mapped[Optional[str]] = mapped_column(String(512))
    city: Mapped[Optional[str]] = mapped_column(String(255))
    address: Mapped[Optional[str]] = mapped_column(Text)
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    remarks_history: Mapped[Optional[list]] = mapped_column(JSONB)
    # Field keys filled by AI Sales Agent Data Update (Sara/Rayan) — yellow-highlight in lists.
    # Cleared for a key when a human manually edits that cell.
    ai_data_update_fields: Mapped[Optional[list]] = mapped_column(JSONB)
    assigned_to: Mapped[str] = mapped_column(String(50), nullable=False, server_default="unassigned")
    assigned_to_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("app_users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # Set only when an admin sends/assigns the lead. Self-imports leave this NULL
    # so "Leads Sent To {user}" never includes a user's own spreadsheet imports.
    assigned_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("app_users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    market_role: Mapped[MarketRole] = mapped_column(
        Enum(MarketRole), default=MarketRole.unknown, nullable=False, index=True
    )
    market_role_reasoning: Mapped[Optional[str]] = mapped_column(Text)
    market_role_confidence: Mapped[Optional[float]] = mapped_column(Numeric(4, 2))
    producer_tier: Mapped[Optional["ProducerTier"]] = mapped_column(Enum(ProducerTier))
    producer_conversion_pct: Mapped[Optional[float]] = mapped_column(Numeric(5, 2))
    producer_tier_reasoning: Mapped[Optional[str]] = mapped_column(Text)
    interested_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    interested_follow_up_ack_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    follow_up_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    # Membership in the dedicated "Interested Clients" leads-table section.
    interested_clients_list_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), index=True
    )
    # Targeted pool modules: upload (spreadsheet) vs discover (AI / search leads).
    intake_method: Mapped[Optional[str]] = mapped_column(String(40), index=True)
    remarks_03: Mapped[Optional[str]] = mapped_column(Text)
    remarks_04: Mapped[Optional[str]] = mapped_column(Text)
    master_type: Mapped[str] = mapped_column(
        String(50), nullable=False, default="fmcg", server_default="'fmcg'"
    )
    # SCHEDULE MEETING list → PA Travel/meetings bridge
    # pending = in list, not yet confirmed; scheduled = visible to PA
    meeting_status: Mapped[Optional[str]] = mapped_column(String(40), index=True)
    meeting_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), index=True)
    meeting_location: Mapped[Optional[str]] = mapped_column(String(512))
    meeting_notes: Mapped[Optional[str]] = mapped_column(Text)
    meeting_priority: Mapped[Optional[int]] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    contacts: Mapped[list["Contact"]] = relationship(back_populates="buyer")
    export_history: Mapped[list["ExportHistory"]] = relationship(back_populates="buyer")
    lead_scores: Mapped[list["LeadScore"]] = relationship(back_populates="buyer")
    quotations: Mapped[list["Quotation"]] = relationship(back_populates="buyer")
    research_profile: Mapped[Optional["BuyerResearchProfile"]] = relationship(
        back_populates="buyer",
        uselist=False,
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class BuyerResearchProfile(Base):
    __tablename__ = "buyer_research_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    buyer_id: Mapped[int] = mapped_column(
        ForeignKey("buyers.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    website_summary: Mapped[Optional[str]] = mapped_column(Text)
    social_summary: Mapped[Optional[str]] = mapped_column(Text)
    relationship_context: Mapped[Optional[str]] = mapped_column(Text)
    signals: Mapped[list] = mapped_column(JSONB, default=list)
    matched_categories: Mapped[list] = mapped_column(JSONB, default=list)
    matched_products: Mapped[list] = mapped_column(JSONB, default=list)
    product_fit_score: Mapped[int] = mapped_column(Integer, default=0)
    raw: Mapped[Optional[dict]] = mapped_column(JSONB)
    researched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    buyer: Mapped["Buyer"] = relationship(back_populates="research_profile")


class Contact(Base):
    __tablename__ = "contacts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    buyer_id: Mapped[int] = mapped_column(ForeignKey("buyers.id"), nullable=False, index=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    designation: Mapped[Optional[str]] = mapped_column(String(255))
    email: Mapped[Optional[str]] = mapped_column(String(255))
    phone: Mapped[Optional[str]] = mapped_column(String(50))
    secondary_mobile: Mapped[Optional[str]] = mapped_column(String(50))
    primary_phone: Mapped[Optional[str]] = mapped_column(String(50))
    secondary_phone: Mapped[Optional[str]] = mapped_column(String(50))
    secondary_email: Mapped[Optional[str]] = mapped_column(String(255))
    linkedin_profile_url: Mapped[Optional[str]] = mapped_column(String(512))
    nationality: Mapped[Optional[str]] = mapped_column(String(100))
    date_of_birth: Mapped[Optional[date]] = mapped_column(Date)
    preferred_language: Mapped[Optional[str]] = mapped_column(String(50), default="en")
    consent_status: Mapped[ConsentStatus] = mapped_column(
        Enum(ConsentStatus), default=ConsentStatus.unknown, nullable=False
    )
    data_source: Mapped[Optional[str]] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # WhatsApp Cloud API — wa_id is the E.164 number Meta uses as the recipient identifier.
    wa_id: Mapped[Optional[str]] = mapped_column(String(50))
    whatsapp_opt_in: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Rolling 24h customer-service window — set/refreshed on inbound messages.
    whatsapp_window_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    buyer: Mapped["Buyer"] = relationship(back_populates="contacts")
    interactions: Mapped[list["Interaction"]] = relationship(back_populates="contact")
    scheduled_events: Mapped[list["ScheduledEvent"]] = relationship(back_populates="contact")


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    category: Mapped[Optional[str]] = mapped_column(String(100))
    spec_sheet: Mapped[Optional[dict]] = mapped_column(JSONB)
    price_tiers: Mapped[Optional[dict]] = mapped_column(JSONB)
    moq: Mapped[Optional[str]] = mapped_column(String(100))
    packaging_options: Mapped[Optional[dict]] = mapped_column(JSONB)
    certifications: Mapped[Optional[dict]] = mapped_column(JSONB)

    export_history: Mapped[list["ExportHistory"]] = relationship(back_populates="product")
    quotations: Mapped[list["Quotation"]] = relationship(back_populates="product")
    quotation_line_items: Mapped[list["QuotationLineItem"]] = relationship(
        back_populates="product"
    )


class ExportHistory(Base):
    __tablename__ = "export_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    buyer_id: Mapped[int] = mapped_column(ForeignKey("buyers.id"), nullable=False, index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), nullable=False)
    order_date: Mapped[date] = mapped_column(Date, nullable=False)
    quantity: Mapped[Optional[float]] = mapped_column(Numeric(12, 2))
    unit_price: Mapped[Optional[float]] = mapped_column(Numeric(12, 2))
    destination_port: Mapped[Optional[str]] = mapped_column(String(255))
    incoterms: Mapped[Optional[str]] = mapped_column(String(20))
    status: Mapped[ExportStatus] = mapped_column(Enum(ExportStatus), default=ExportStatus.pending)

    buyer: Mapped["Buyer"] = relationship(back_populates="export_history")
    product: Mapped["Product"] = relationship(back_populates="export_history")


class Interaction(Base):
    __tablename__ = "interactions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    contact_id: Mapped[int] = mapped_column(ForeignKey("contacts.id"), nullable=False, index=True)
    channel: Mapped[Channel] = mapped_column(Enum(Channel), nullable=False, index=True)
    direction: Mapped[Direction] = mapped_column(Enum(Direction), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    subject: Mapped[Optional[str]] = mapped_column(String(500))
    sentiment: Mapped[Optional[str]] = mapped_column(String(50))
    language: Mapped[Optional[str]] = mapped_column(String(50))
    handled_by: Mapped[HandledBy] = mapped_column(Enum(HandledBy), default=HandledBy.agent)
    status: Mapped[InteractionStatus] = mapped_column(
        Enum(InteractionStatus), default=InteractionStatus.draft
    )
    approved_by: Mapped[Optional[str]] = mapped_column(String(255))
    attachments: Mapped[list] = mapped_column(JSONB, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    # WhatsApp Cloud API delivery tracking.
    provider_message_id: Mapped[Optional[str]] = mapped_column(String(128), index=True)
    template_name: Mapped[Optional[str]] = mapped_column(String(255))
    wa_status: Mapped[Optional[str]] = mapped_column(String(50))
    # Owner of a Baileys (personal QR) WhatsApp message — not used for Cloud API.
    personal_whatsapp_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, index=True, deferred=True
    )
    # Train Sara & Rayan flag lives in attachments JSON ({"type":"ai_training"}) —
    # do not add a boolean column here (ALTER on interactions caused Railway 502s).

    contact: Mapped["Contact"] = relationship(back_populates="interactions")


class LeadScore(Base):
    __tablename__ = "lead_scores"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    buyer_id: Mapped[int] = mapped_column(ForeignKey("buyers.id"), nullable=False, index=True)
    score: Mapped[LeadScoreLabel] = mapped_column(
        Enum(
            LeadScoreLabel,
            name="leadscorelabel",
            native_enum=False,
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
            validate_strings=True,
        ),
        nullable=False,
    )
    reasoning: Mapped[str] = mapped_column(Text, nullable=False)
    score_factors: Mapped[Optional[dict]] = mapped_column(JSONB)
    scored_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    buyer: Mapped["Buyer"] = relationship(back_populates="lead_scores")


class Quotation(Base):
    __tablename__ = "quotations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    buyer_id: Mapped[int] = mapped_column(ForeignKey("buyers.id"), nullable=False)
    product_id: Mapped[Optional[int]] = mapped_column(ForeignKey("products.id"), nullable=True)
    quantity: Mapped[Optional[float]] = mapped_column(Numeric(12, 2), nullable=True)
    unit_price: Mapped[Optional[float]] = mapped_column(Numeric(12, 2), nullable=True)
    incoterms: Mapped[Optional[str]] = mapped_column(String(20))
    validity_date: Mapped[Optional[date]] = mapped_column(Date)
    status: Mapped[QuotationStatus] = mapped_column(Enum(QuotationStatus), default=QuotationStatus.draft)
    pdf_path: Mapped[Optional[str]] = mapped_column(String(512))
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    buyer: Mapped["Buyer"] = relationship(back_populates="quotations")
    product: Mapped[Optional["Product"]] = relationship(back_populates="quotations")
    line_items: Mapped[list["QuotationLineItem"]] = relationship(
        back_populates="quotation",
        cascade="all, delete-orphan",
        order_by="QuotationLineItem.sort_order",
    )


class QuotationLineItem(Base):
    __tablename__ = "quotation_line_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    quotation_id: Mapped[int] = mapped_column(ForeignKey("quotations.id", ondelete="CASCADE"), nullable=False)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), nullable=False)
    quantity: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    unit_price: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    quotation: Mapped["Quotation"] = relationship(back_populates="line_items")
    product: Mapped["Product"] = relationship(back_populates="quotation_line_items")


class ScheduledEvent(Base):
    __tablename__ = "scheduled_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    contact_id: Mapped[int] = mapped_column(ForeignKey("contacts.id"), nullable=False)
    event_type: Mapped[EventType] = mapped_column(Enum(EventType), nullable=False)
    trigger_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[ScheduledEventStatus] = mapped_column(
        Enum(ScheduledEventStatus), default=ScheduledEventStatus.pending
    )
    message_draft: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    contact: Mapped["Contact"] = relationship(back_populates="scheduled_events")


class EmailTemplate(Base):
    __tablename__ = "email_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    subject: Mapped[str] = mapped_column(String(500), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    attachments: Mapped[list] = mapped_column(JSONB, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class WhatsAppPersonalTemplate(Base):
    """Reusable free-text WhatsApp bodies for Personal (QR / Baileys) sends — not Meta WABA templates."""

    __tablename__ = "whatsapp_personal_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("app_users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class TelegramPersonalTemplate(Base):
    """Reusable free-text Telegram bodies for Telegram Mobile (GramJS) sends."""

    __tablename__ = "telegram_personal_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("app_users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class WhatsAppTemplate(Base):
    """WhatsApp message templates on the Meta WABA — synced and/or submitted via this app."""

    __tablename__ = "whatsapp_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    meta_template_id: Mapped[Optional[str]] = mapped_column(String(128), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    category: Mapped[Optional[str]] = mapped_column(String(50))
    language: Mapped[str] = mapped_column(String(20), nullable=False, default="en")
    status: Mapped[WhatsAppTemplateStatus] = mapped_column(
        Enum(WhatsAppTemplateStatus), default=WhatsAppTemplateStatus.pending, nullable=False
    )
    components: Mapped[Optional[list]] = mapped_column(JSONB, default=list)
    body_text: Mapped[Optional[str]] = mapped_column(Text)
    variable_count: Mapped[int] = mapped_column(Integer, default=0)
    submitted_by_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("app_users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    rejection_reason: Mapped[Optional[str]] = mapped_column(Text)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class WhatsAppTemplateStatusEvent(Base):
    """In-app notifications when a submitted WhatsApp template is reviewed by Meta."""

    __tablename__ = "whatsapp_template_status_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    template_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("whatsapp_templates.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    event_type: Mapped[str] = mapped_column(String(50), nullable=False)
    message: Mapped[str] = mapped_column(String(500), nullable=False)
    read_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PersonalizedFollowupDraft(Base):
    """Human-reviewed post-call follow-up drafted from closed captions (email + WhatsApp)."""

    __tablename__ = "personalized_followup_drafts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    interaction_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("interactions.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    buyer_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("buyers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    contact_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True
    )
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("app_users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    call_outcome: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="awaiting_transcript")
    subject: Mapped[Optional[str]] = mapped_column(String(500))
    email_body: Mapped[Optional[str]] = mapped_column(Text)
    whatsapp_body: Mapped[Optional[str]] = mapped_column(Text)
    transcript_excerpt: Mapped[Optional[str]] = mapped_column(Text)
    generation_error: Mapped[Optional[str]] = mapped_column(Text)
    email_interaction_id: Mapped[Optional[int]] = mapped_column(Integer)
    whatsapp_interaction_id: Mapped[Optional[int]] = mapped_column(Integer)
    email_send_status: Mapped[Optional[str]] = mapped_column(String(40))
    whatsapp_send_status: Mapped[Optional[str]] = mapped_column(String(40))
    whatsapp_personal_send_status: Mapped[Optional[str]] = mapped_column(String(40))
    email_send_message: Mapped[Optional[str]] = mapped_column(Text)
    whatsapp_send_message: Mapped[Optional[str]] = mapped_column(Text)
    whatsapp_personal_send_message: Mapped[Optional[str]] = mapped_column(Text)
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(100), nullable=False)
    entity_id: Mapped[int] = mapped_column(Integer, nullable=False)
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    actor: Mapped[Optional[str]] = mapped_column(String(255))
    details: Mapped[Optional[dict]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AppUser(Base):
    """Dashboard login accounts (admin vs sales user)."""

    __tablename__ = "app_users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(100), nullable=False, unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[AppUserRole] = mapped_column(
        Enum(AppUserRole, name="app_user_role", values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=AppUserRole.user,
    )
    password_hash: Mapped[str] = mapped_column(String(512), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Per-user cPanel mailbox (IMAP/SMTP). Shared hosts live in env; credentials here.
    mailbox_email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True, index=True)
    mailbox_password_encrypted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    mailbox_display_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    mailbox_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    sessions: Mapped[list["AppUserSession"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )


class AppUserSession(Base):
    """Opaque bearer tokens for dashboard sessions."""

    __tablename__ = "app_user_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False)
    token: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    user: Mapped["AppUser"] = relationship(back_populates="sessions")


class EmailActivityEvent(Base):
    """Real-time outbound email activity notifications (sent, failed, bulk, etc.)."""

    __tablename__ = "email_activity_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    severity: Mapped[str] = mapped_column(String(20), nullable=False, default="info")
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("app_users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    buyer_id: Mapped[Optional[int]] = mapped_column(ForeignKey("buyers.id"), nullable=True)
    contact_id: Mapped[Optional[int]] = mapped_column(ForeignKey("contacts.id"), nullable=True)
    interaction_id: Mapped[Optional[int]] = mapped_column(ForeignKey("interactions.id"), nullable=True)
    details: Mapped[Optional[dict]] = mapped_column(JSONB)
    read_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class UserActivityEvent(Base):
    """Per-user work events for daily KPI Generation reports (from go-live onward)."""

    __tablename__ = "user_activity_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    activity_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    entity_type: Mapped[Optional[str]] = mapped_column(String(100))
    entity_id: Mapped[Optional[int]] = mapped_column(Integer)
    details: Mapped[Optional[dict]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class ManualKpiEntry(Base):
    """Manually logged off-system KPI rows (phone/WhatsApp/email work outside Sales Agent)."""

    __tablename__ = "manual_kpi_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    activity_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    person_name: Mapped[Optional[str]] = mapped_column(String(255))
    company: Mapped[Optional[str]] = mapped_column(String(500))
    country: Mapped[Optional[str]] = mapped_column(String(120))
    contact_type: Mapped[Optional[str]] = mapped_column(String(80))
    follow_up_type: Mapped[Optional[str]] = mapped_column(String(80))
    wechat_contacts: Mapped[Optional[str]] = mapped_column(String(40))
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["AppUser"] = relationship("AppUser")


class MailLabel(Base):
    """Per-user Gmail-style label for IMAP messages (app-level, not IMAP folders)."""

    __tablename__ = "mail_labels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    color: Mapped[str] = mapped_column(String(32), nullable=False, default="#34d399")
    # Domain or full email — messages from matching addresses route here (not subject text).
    match_query: Mapped[Optional[str]] = mapped_column(String(255))
    # Keyword — matches subject / preview / body / sender name only (not label name).
    match_keyword: Mapped[Optional[str]] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MailLabelAssignment(Base):
    __tablename__ = "mail_label_assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    label_id: Mapped[int] = mapped_column(
        ForeignKey("mail_labels.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    folder: Mapped[str] = mapped_column(String(64), nullable=False, default="inbox")
    message_uid: Mapped[str] = mapped_column(String(128), nullable=False)
    message_id: Mapped[Optional[str]] = mapped_column(String(512))
    thread_id: Mapped[Optional[str]] = mapped_column(String(255))
    from_email: Mapped[Optional[str]] = mapped_column(String(255))
    subject_key: Mapped[Optional[str]] = mapped_column(String(255))
    # IMAP mailbox owner (Asim switcher: marketing/info/essence user ids).
    mailbox_user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MailComposeDraft(Base):
    """Saved outbound compose drafts (auto-saved when closing the compose modal)."""

    __tablename__ = "mail_compose_drafts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    to_addrs: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    cc_addrs: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    subject: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AiModeSettings(Base):
    """Per-user after-hours AI Mode toggle and auto-reply templates."""

    __tablename__ = "ai_mode_settings"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), primary_key=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    email_auto_reply_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    whatsapp_auto_reply_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    form_url: Mapped[Optional[str]] = mapped_column(String(512))
    email_subject_template: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    email_body_template: Mapped[str] = mapped_column(Text, nullable=False, default="")
    whatsapp_body_template: Mapped[str] = mapped_column(Text, nullable=False, default="")
    query_keywords: Mapped[Optional[list]] = mapped_column(JSONB)
    last_email_processed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    enabled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AiModeAutoReplyLog(Base):
    """Deduped log of AI Mode auto-replies (email / WhatsApp)."""

    __tablename__ = "ai_mode_auto_reply_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    channel: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    message_key: Mapped[str] = mapped_column(String(512), nullable=False, index=True)
    recipient: Mapped[Optional[str]] = mapped_column(String(255))
    subject: Mapped[Optional[str]] = mapped_column(String(500))
    preview: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="sent")
    detail: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class AiModeQueryLog(Base):
    """Per-user inbound emails that matched AI Mode query keywords."""

    __tablename__ = "ai_mode_query_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    message_key: Mapped[str] = mapped_column(String(512), nullable=False)
    folder: Mapped[str] = mapped_column(String(64), nullable=False, default="inbox")
    uid: Mapped[str] = mapped_column(String(128), nullable=False)
    from_email: Mapped[Optional[str]] = mapped_column(String(255))
    from_name: Mapped[Optional[str]] = mapped_column(String(255))
    subject: Mapped[Optional[str]] = mapped_column(String(500))
    preview: Mapped[Optional[str]] = mapped_column(Text)
    received_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class AiCompanyLifecycle(Base):
    """AISOS Module 3 — company lifecycle stage with timestamped history."""

    __tablename__ = "ai_company_lifecycle"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    buyer_id: Mapped[int] = mapped_column(
        ForeignKey("buyers.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    stage: Mapped[str] = mapped_column(String(50), nullable=False, default="new_lead", index=True)
    stage_entered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    history: Mapped[Optional[list]] = mapped_column(JSONB)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    meeting_status: Mapped[str] = mapped_column(
        String(30), nullable=False, default="not_scheduled", server_default="not_scheduled"
    )
    meeting_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    meeting_reminder_sent_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True)
    )
    updated_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("app_users.id", ondelete="SET NULL")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AiLeadTransferLog(Base):
    """Admin lead-assignment events for Company lifecycle → Assigned.

    Each row is one transfer batch (e.g. \"50 leads transferred to Usman\").
    Assigned chip count = sum of lead_count across all rows.
    """

    __tablename__ = "ai_lead_transfer_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("app_users.id", ondelete="SET NULL"), index=True
    )
    to_user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    to_label: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    lead_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    buyer_ids: Mapped[Optional[list]] = mapped_column(JSONB)
    message: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class AiCallActivityLog(Base):
    """Per-user call activity for Company lifecycle → Calling.

    Each row is one call statement (e.g. \"Usman called Acme Trading\").
    Calling chip count = total rows. Includes admin and sales users alike.
    """

    __tablename__ = "ai_call_activity_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_label: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    buyer_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("buyers.id", ondelete="SET NULL"), index=True
    )
    company_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    interaction_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("interactions.id", ondelete="SET NULL"), index=True
    )
    message: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class AiFollowUpActivityLog(Base):
    """Per-user Follow up clients activity for Company lifecycle → Follow-up.

    Each row is one statement (e.g. \"Usman put Acme Trading in Follow up clients\").
    Includes admin and sales users alike.
    """

    __tablename__ = "ai_follow_up_activity_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_label: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    buyer_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("buyers.id", ondelete="SET NULL"), index=True
    )
    company_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    event_type: Mapped[str] = mapped_column(String(50), nullable=False, default="placed")
    follow_up_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    message: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class AiInterestedActivityLog(Base):
    """Per-user Interested Clients activity for Company lifecycle → Interested.

    Each row is one statement (e.g. \"Usman added Acme Trading to Interested Clients\").
    Tracks who placed leads on the Interested Clients table for admin/user feeds.
    """

    __tablename__ = "ai_interested_activity_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_label: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    buyer_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("buyers.id", ondelete="SET NULL"), index=True
    )
    company_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    event_type: Mapped[str] = mapped_column(String(50), nullable=False, default="placed")
    source: Mapped[str] = mapped_column(String(50), nullable=False, default="manual")
    message: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class AiNotInterestedActivityLog(Base):
    """Per-user Not interested clients activity for Company lifecycle → Not Interested."""

    __tablename__ = "ai_not_interested_activity_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_label: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    buyer_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("buyers.id", ondelete="SET NULL"), index=True
    )
    company_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    event_type: Mapped[str] = mapped_column(String(50), nullable=False, default="placed")
    source: Mapped[str] = mapped_column(String(50), nullable=False, default="call")
    message: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class BulkEmailSchedule(Base):
    """Queued bulk email campaign — executed on Vercel mailer at scheduled_at."""

    __tablename__ = "bulk_email_schedules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    mailbox_email: Mapped[str] = mapped_column(String(255), nullable=False)
    username: Mapped[str] = mapped_column(String(100), nullable=False)
    display_name: Mapped[Optional[str]] = mapped_column(String(255))
    buyer_ids: Mapped[list] = mapped_column(JSONB, default=list)
    leads: Mapped[list] = mapped_column(JSONB, default=list)
    subject: Mapped[str] = mapped_column(String(500), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    batch_size: Mapped[int] = mapped_column(Integer, default=10)
    message_delay_seconds: Mapped[float] = mapped_column(Float, default=2.0)
    batch_pause_seconds: Mapped[float] = mapped_column(Float, default=45.0)
    status: Mapped[str] = mapped_column(String(30), default="pending", index=True)
    result_message: Mapped[Optional[str]] = mapped_column(Text)
    executed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class HorekaLineItem(Base):
    """Horeka / B2B line item with packaging, price tiers, and MOQ."""

    __tablename__ = "horeka_line_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sno: Mapped[int] = mapped_column(Integer, default=0, index=True)
    category: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    sub_category: Mapped[Optional[str]] = mapped_column(String(100))
    brand: Mapped[str] = mapped_column(String(100), default="ESSENCE")
    item_code: Mapped[Optional[str]] = mapped_column(String(50), index=True)
    product_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    packaging: Mapped[str] = mapped_column(String(255), default="")
    unit: Mapped[str] = mapped_column(String(50), default="USD/carton")
    standard_price: Mapped[float] = mapped_column(Float, default=0.0)
    bulk_tier1_price: Mapped[Optional[float]] = mapped_column(Float)
    bulk_tier2_price: Mapped[Optional[float]] = mapped_column(Float)
    moq: Mapped[Optional[str]] = mapped_column(String(100), default="10 Master Cartons")
    stock_status: Mapped[str] = mapped_column(String(50), default="In Stock")
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class LeadImportBatch(Base):
    """One spreadsheet import into a list/source — used for admin Undo last import."""

    __tablename__ = "lead_import_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    buyer_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("app_users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    import_job_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    rolled_back_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    rolled_back_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("app_users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class CustomLeadModule(Base):
    """Dynamic custom lead module/list under Old clients."""

    __tablename__ = "custom_lead_modules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    icon: Mapped[str] = mapped_column(String(50), default="📋")
    color: Mapped[str] = mapped_column(String(50), default="#3b82f6")
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class DayCountryTarget(Base):
    """Target countries assigned per day of week (and optionally per sales user)."""

    __tablename__ = "day_country_targets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    day_of_week: Mapped[str] = mapped_column(String(20), nullable=False, index=True)  # "monday", "friday", etc.
    country: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    assigned_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("app_users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("app_users.id", ondelete="SET NULL"), nullable=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    assigned_user: Mapped[Optional["AppUser"]] = relationship("AppUser", foreign_keys=[assigned_user_id])


class WorkspaceLeadLifecycle(Base):
    """Outreach lifecycle status and review states for target workspace leads."""

    __tablename__ = "workspace_lead_lifecycles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    buyer_id: Mapped[int] = mapped_column(ForeignKey("buyers.id", ondelete="CASCADE"), nullable=False, unique=True, index=True)
    user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("app_users.id", ondelete="SET NULL"), nullable=True, index=True)
    
    # 4 core stages: "fresh", "needs_follow_up", "not_interested", "no_response"
    stage: Mapped[str] = mapped_column(String(40), default="fresh", nullable=False, index=True)
    
    # Not interested reason & remarks
    not_interested_reason: Mapped[Optional[str]] = mapped_column(String(80))  # "price_high", "items_mismatch", "client_exporter", "has_supplier", "other"
    not_interested_remarks: Mapped[Optional[str]] = mapped_column(Text)
    
    # Needs follow-up details
    follow_up_reason: Mapped[Optional[str]] = mapped_column(String(120))  # "need_approval_ho", "call_back_later", "searching_vendors", "quotation_requested", or custom
    follow_up_action: Mapped[Optional[str]] = mapped_column(String(40))  # "call", "email", "quotation", "whatsapp"
    follow_up_date: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    
    # No-response checks & manual audit proof
    whatsapp_call_tried: Mapped[bool] = mapped_column(Boolean, default=False)
    whatsapp_call_proof: Mapped[Optional[str]] = mapped_column(Text)
    searched_internet_email: Mapped[bool] = mapped_column(Boolean, default=False)
    searched_internet_phone: Mapped[bool] = mapped_column(Boolean, default=False)
    
    # Contact replacements
    replacement_email: Mapped[Optional[str]] = mapped_column(String(255))
    replacement_contact_name: Mapped[Optional[str]] = mapped_column(String(255))
    replacement_phone: Mapped[Optional[str]] = mapped_column(String(50))
    
    # LinkedIn actions
    linkedin_request_sent: Mapped[bool] = mapped_column(Boolean, default=False)
    linkedin_msg_sent: Mapped[bool] = mapped_column(Boolean, default=False)
    
    # Activity counters for dead lead meter
    emails_sent_count: Mapped[int] = mapped_column(Integer, default=0)
    calls_made_count: Mapped[int] = mapped_column(Integer, default=0)
    
    # Drip campaign flag
    is_drip_candidate: Mapped[bool] = mapped_column(Boolean, default=False)
    moved_to_drip_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    buyer: Mapped["Buyer"] = relationship("Buyer")
    user: Mapped[Optional["AppUser"]] = relationship("AppUser")


class DripCampaignLead(Base):
    """Replaced & stale contacts enrolled in 15-day cadence email nurture."""

    __tablename__ = "drip_campaign_leads"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    company_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    product_type: Mapped[str] = mapped_column(String(255), default="FMCG / General")
    contact_person_name: Mapped[Optional[str]] = mapped_column(String(255))
    contact_designation: Mapped[Optional[str]] = mapped_column(String(255))
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    country: Mapped[Optional[str]] = mapped_column(String(100), index=True)
    source_buyer_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("app_users.id", ondelete="SET NULL"), nullable=True)
    
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_drip_sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    drip_emails_sent_count: Mapped[int] = mapped_column(Integer, default=0)
    responses_received_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(40), default="active", index=True)  # "active", "paused", "converted", "unsubscribed"
    notes: Mapped[Optional[str]] = mapped_column(Text)

    user: Mapped[Optional["AppUser"]] = relationship("AppUser")


class WorkspaceReviewOption(Base):
    """Customizable dropdown options for follow-up review reasons and objection actions."""

    __tablename__ = "workspace_review_options"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    category: Mapped[str] = mapped_column(String(40), nullable=False, index=True)  # "follow_up_reason", "not_interested_reason"
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    value: Mapped[str] = mapped_column(String(100), nullable=False)
    action_hint: Mapped[Optional[str]] = mapped_column(String(255))
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by_user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AiSalesAgentState(Base):
    """Single-row JSON snapshot of Sara/Rayan assigned pipeline (survives redeploys)."""

    __tablename__ = "ai_sales_agent_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tasks: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    runners: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class MailerPictureLibraryState(Base):
    """Single-row shared mailer picture library (groups + image metadata). Survives redeploys."""

    __tablename__ = "mailer_picture_library_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    groups: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class AutoTrashSettings(Base):
    """Per-mailbox-user Auto Trash toggle (only that user's inbox is scanned when ON)."""

    __tablename__ = "auto_trash_settings"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), primary_key=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_scan_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AutoTrashProfile(Base):
    """Global learned trash patterns (from shared learning mailboxes' Trash folders)."""

    __tablename__ = "auto_trash_profile"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ready: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    rules: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    samples_seen: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_learned_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AutoTrashLog(Base):
    """Audit of emails auto-moved to Trash."""

    __tablename__ = "auto_trash_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    message_key: Mapped[str] = mapped_column(String(512), nullable=False)
    from_email: Mapped[Optional[str]] = mapped_column(String(255))
    subject: Mapped[Optional[str]] = mapped_column(String(500))
    reason: Mapped[Optional[str]] = mapped_column(String(255))
    triage_category: Mapped[Optional[str]] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="moved")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class AiSalesAgentRunLog(Base):
    """Assign vs process-start activity for AI Sales Agent (Sara / Rayan / pipeline).

    event_kind=assign  — contacts placed on pipeline / agent / lane (not yet used)
    event_kind=run_start — Outreach / Data Update / AI Auto Mode process actually started
    """

    __tablename__ = "ai_sales_agent_run_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("app_users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    user_label: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    event_kind: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    persona: Mapped[str] = mapped_column(String(32), nullable=False, default="", index=True)
    queue_lane: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    contact_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    contacts: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    note: Mapped[Optional[str]] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )



