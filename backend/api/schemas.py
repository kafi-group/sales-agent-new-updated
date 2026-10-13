from datetime import date, datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class BuyerCreate(BaseModel):
    company_name: str
    website_url: Optional[str] = None
    country: Optional[str] = None
    industry: Optional[str] = None
    linkedin_company_url: Optional[str] = None
    source: Optional[str] = "manual"


class BuyerRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    company_name: str
    website_url: Optional[str]
    country: Optional[str]
    industry: Optional[str]
    source: Optional[str]
    company_grading: Optional[str] = None
    market_role: str = "unknown"
    market_role_reasoning: Optional[str] = None
    market_role_confidence: Optional[float] = None
    producer_tier: Optional[str] = None
    producer_conversion_pct: Optional[float] = None
    producer_tier_reasoning: Optional[str] = None
    created_at: datetime
    latest_score: Optional[str] = None
    score_reasoning: Optional[str] = None


class BuyerListResponse(BaseModel):
    total: int
    page: int = 1
    page_size: int = 20
    total_pages: int = 1
    rows: list[BuyerRead]


class CompanyNameSuggestion(BaseModel):
    id: int
    company_name: str
    country: Optional[str] = None
    industry: Optional[str] = None
    source: Optional[str] = None


class CompanyNameSuggestionsResponse(BaseModel):
    q: str
    rows: list[CompanyNameSuggestion]


class DialableContactSuggestion(BaseModel):
    buyer_id: int
    contact_id: Optional[int] = None
    company_name: Optional[str] = ""
    contact_name: Optional[str] = ""
    phone: str
    country: Optional[str] = None
    designation: Optional[str] = None
    grading: Optional[str] = None
    label: str


class DialableContactSuggestionsResponse(BaseModel):
    q: str = ""
    section: Optional[str] = None
    country: Optional[str] = None
    grade: Optional[str] = None
    designation: Optional[str] = None
    rows: list[DialableContactSuggestion]


class CallFilterSectionOption(BaseModel):
    id: str = ""
    label: str = ""
    icon: Optional[str] = None
    count: Optional[int] = 0


class CallFilterOptionsResponse(BaseModel):
    sections: list[CallFilterSectionOption] = []
    countries: list[str] = []
    grades: list[str] = []
    designations: list[str] = []


class QuotationEligibleLeadRead(BuyerRead):
    latest_score: str
    score_reasoning: str
    contact_email: str
    contact_name: Optional[str] = None


class ContactCreate(BaseModel):
    buyer_id: int
    full_name: str
    designation: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    nationality: Optional[str] = None
    date_of_birth: Optional[date] = None
    preferred_language: Optional[str] = "en"
    consent_status: str = "unknown"
    whatsapp_opt_in: bool = False


class ContactUpdate(BaseModel):
    full_name: Optional[str] = None
    designation: Optional[str] = None
    email: Optional[str] = None
    secondary_email: Optional[str] = None
    phone: Optional[str] = None
    preferred_language: Optional[str] = None
    consent_status: Optional[str] = None
    date_of_birth: Optional[date] = None
    nationality: Optional[str] = None
    whatsapp_opt_in: Optional[bool] = None


class ConsentSummaryRead(BaseModel):
    total: int
    unknown: int
    granted: int
    denied: int
    with_birthday: int


class ComplianceContactRead(BaseModel):
    id: int
    buyer_id: int
    company_name: str
    country: Optional[str] = None
    full_name: str
    designation: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    date_of_birth: Optional[date] = None
    nationality: Optional[str] = None
    consent_status: str
    preferred_language: Optional[str] = None
    birthday_outreach_ok: bool = False
    whatsapp_opt_in: bool = False


class BulkConsentUpdate(BaseModel):
    contact_ids: list[int] = Field(min_length=1)
    consent_status: str


class BulkWhatsAppOptInUpdate(BaseModel):
    contact_ids: list[int] = Field(min_length=1)
    opt_in: bool


class ContactRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    buyer_id: int
    full_name: str
    designation: Optional[str] = None
    email: Optional[str]
    phone: Optional[str]
    preferred_language: Optional[str]
    consent_status: str = "unknown"
    whatsapp_opt_in: bool = False
    wa_id: Optional[str] = None
    within_session_window: bool = False
    window_expires_at: Optional[datetime] = None


class ProductCreate(BaseModel):
    name: str
    category: Optional[str] = None
    spec_sheet: Optional[dict[str, Any]] = None
    price_tiers: Optional[dict[str, Any]] = None
    moq: Optional[str] = None
    packaging_options: Optional[Any] = None
    certifications: Optional[Any] = None


class ProductRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    category: Optional[str]
    price_tiers: Optional[dict[str, Any]]
    moq: Optional[str]


class QuotationLineCreate(BaseModel):
    product_id: int
    quantity: float = Field(gt=0)
    price_tier: str = "standard"


class QuotationCreate(BaseModel):
    buyer_id: int
    lines: list[QuotationLineCreate] | None = None
    product_id: int | None = None
    quantity: float = Field(default=20, gt=0)
    price_tier: str = "standard"
    incoterms: str = "FOB"
    validity_days: int = 14

    @model_validator(mode="after")
    def normalize_lines(self) -> "QuotationCreate":
        if self.lines:
            return self
        if self.product_id is not None:
            self.lines = [
                QuotationLineCreate(
                    product_id=self.product_id,
                    quantity=self.quantity,
                    price_tier=self.price_tier,
                )
            ]
            return self
        raise ValueError("Provide lines or product_id")


class QuotationBatchCreate(BaseModel):
    quantity: float = Field(default=20, gt=0)
    incoterms: str = "FOB"
    max_quotes: int = Field(default=3, ge=1, le=10)


class QuotationLineRead(BaseModel):
    product_id: int
    product_name: Optional[str] = None
    quantity: float
    unit_price: float
    price_unit: Optional[str] = None
    line_total: float


class QuotationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    buyer_id: int
    product_id: Optional[int] = None
    quantity: Optional[float] = None
    unit_price: Optional[float] = None
    incoterms: Optional[str]
    validity_date: Optional[date]
    status: str
    pdf_path: Optional[str]
    buyer_name: Optional[str] = None
    product_name: Optional[str] = None
    price_unit: Optional[str] = None
    line_total: Optional[float] = None
    lines: list[QuotationLineRead] = Field(default_factory=list)
    grand_total: Optional[float] = None


class InteractionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    contact_id: int
    channel: str
    direction: str
    subject: Optional[str]
    content: str
    status: str
    created_at: datetime
    company_name: Optional[str] = None
    contact_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    template_name: Optional[str] = None
    wa_status: Optional[str] = None
    wa_send_error: Optional[str] = None
    attachments: list["EmailAttachmentRead"] = Field(default_factory=list)


class EmailAttachmentRead(BaseModel):
    id: str
    filename: str
    content_type: str
    size: int
    storage_path: Optional[str] = None


class InteractionAttachmentsUpdate(BaseModel):
    attachments: list[EmailAttachmentRead] = Field(default_factory=list)


class InteractionApprove(BaseModel):
    content: Optional[str] = None
    approved_by: str = "sales_rep"
    send: bool = True
    template_name: Optional[str] = None
    template_language: str = "en_US"
    template_variables: list[str] = Field(default_factory=list)


class InteractionApproveResponse(BaseModel):
    interaction: InteractionRead
    sent: bool
    send_status: Optional[str] = None
    send_message: Optional[str] = None


class EmailDraftRequest(BaseModel):
    contact_id: int
    goal: str
    product_name: Optional[str] = None
    attachments: list[EmailAttachmentRead] = Field(default_factory=list)


class ManualEmailDraftRequest(BaseModel):
    buyer_id: int
    subject: str
    body: str
    contact_id: Optional[int] = None
    attachments: list[EmailAttachmentRead] = Field(default_factory=list)
    send: bool = True


class ManualEmailSendResponse(BaseModel):
    interaction: InteractionRead
    sent: bool
    send_status: Optional[str] = None
    send_message: Optional[str] = None


class EmailTemplateCreate(BaseModel):
    name: str
    subject: str
    body: str
    attachments: list[EmailAttachmentRead] = Field(default_factory=list)


class EmailTemplateUpdate(BaseModel):
    name: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    attachments: Optional[list[EmailAttachmentRead]] = None


class EmailTemplateGenerateRequest(BaseModel):
    title: str = Field(min_length=2, max_length=200)


class EmailTemplateGenerateResponse(BaseModel):
    name: str
    subject: str
    body: str


class EmailComposeDraftRequest(BaseModel):
    prompt: str = Field(min_length=8, max_length=4000)
    to: Optional[str] = Field(default=None, max_length=500)
    context: Optional[str] = Field(default=None, max_length=2000)


class EmailComposeDraftResponse(BaseModel):
    subject: str
    body: str


class WhatsAppPersonalTemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    body: str = Field(min_length=1, max_length=4096)


class WhatsAppPersonalTemplateUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    body: Optional[str] = Field(default=None, min_length=1, max_length=4096)


class WhatsAppPersonalTemplateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    body: str
    created_by_user_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime


class TelegramPersonalTemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    body: str = Field(min_length=1, max_length=4096)


class TelegramPersonalTemplateUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    body: Optional[str] = Field(default=None, min_length=1, max_length=4096)


class TelegramPersonalTemplateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    body: str
    created_by_user_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime


class EmailTemplateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    subject: str
    body: str
    attachments: list[EmailAttachmentRead] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class EmailTemplatePreviewRead(BaseModel):
    subject: str
    body: str
    company_name: str
    contact_email: str


class EmailTextPreviewRequest(BaseModel):
    buyer_id: int
    subject: str
    body: str


class BulkManualEmailDraftRequest(BaseModel):
    buyer_ids: list[int] = Field(min_length=1)
    subject: str
    body: str
    attachments: list[EmailAttachmentRead] = Field(default_factory=list)
    send: bool = True
    confirm_overlap: bool = False


class BulkEmailDraftRequest(BaseModel):
    template_id: int
    buyer_ids: list[int] = Field(min_length=1)
    attachments: list[EmailAttachmentRead] = Field(default_factory=list)
    send: bool = True
    confirm_overlap: bool = False


class BulkEmailOverlapCheckRequest(BaseModel):
    buyer_ids: list[int] = Field(min_length=1)


class BulkEmailOverlapCheckResponse(BaseModel):
    has_overlap: bool
    overlapping_count: int = 0
    overlapping_buyer_ids: list[int] = Field(default_factory=list)
    run_in_progress: bool = False
    minutes_ago: int = 0
    minutes_remaining: int = 0
    message: Optional[str] = None


class BulkEmailDraftResultItem(BaseModel):
    buyer_id: int
    company_name: str
    interaction_id: int
    contact_id: int
    sent: bool = False
    send_status: Optional[str] = None
    send_message: Optional[str] = None


class BulkEmailSkippedItem(BaseModel):
    buyer_id: int
    company_name: Optional[str] = None
    reason: str


class BulkEmailDraftResponse(BaseModel):
    created_count: int
    skipped_count: int
    sent_count: int = 0
    failed_count: int = 0
    created: list[BulkEmailDraftResultItem]
    skipped: list[BulkEmailSkippedItem]


class BulkApproveRequest(BaseModel):
    interaction_ids: list[int] = Field(min_length=1)
    approved_by: str = "sales_rep"
    send: bool = True


class BulkApproveResultItem(BaseModel):
    interaction_id: int
    status: str
    sent: bool
    send_status: Optional[str] = None
    send_message: Optional[str] = None


class BulkApproveResponse(BaseModel):
    processed: int
    sent_count: int
    failed_count: int
    results: list[BulkApproveResultItem]


class BulkEmailSettingsRead(BaseModel):
    batch_size: int
    message_delay_seconds: float
    batch_pause_seconds: float
    max_per_request: int
    gmail_daily_limit_hint: int = 500
    recommendation: str


class ProductInterestItem(BaseModel):
    name: str
    category: Optional[str] = None


class ProductInterestEmailRequest(BaseModel):
    contact_id: Optional[int] = None
    products: list[ProductInterestItem] = Field(min_length=1)
    attachments: list[EmailAttachmentRead] = Field(default_factory=list)


class LeadTableRowRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    company_name: str
    country: Optional[str] = None
    call_recommended: Optional[bool] = None
    call_local_time: Optional[str] = None
    call_timezone: Optional[str] = None
    call_reason: Optional[str] = None
    industry: Optional[str] = None
    website_url: Optional[str] = None
    linkedin_company_url: Optional[str] = None
    facebook_company_url: Optional[str] = None
    instagram_company_url: Optional[str] = None
    source: Optional[str] = None
    legacy_serial_no: Optional[int] = None
    company_grading: Optional[str] = None
    product_interest: Optional[str] = None
    city: Optional[str] = None
    address: Optional[str] = None
    remarks: Optional[str] = None
    remarks_03: Optional[str] = None
    remarks_04: Optional[str] = None
    remarks_history: Optional[list] = None
    call_remarks: Optional[str] = None
    assigned_to: str = "unassigned"
    assigned_to_user_id: Optional[int] = None
    follow_up_at: Optional[datetime] = None
    created_at: datetime
    latest_score: Optional[str] = None
    score_reasoning: Optional[str] = None
    scored_at: Optional[datetime] = None
    contact_id: Optional[int] = None
    contact_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    contact_designation: Optional[str] = None
    contact_secondary_mobile: Optional[str] = None
    contact_primary_phone: Optional[str] = None
    contact_secondary_phone: Optional[str] = None
    contact_secondary_email: Optional[str] = None
    market_role: Optional[str] = "unknown"
    market_role_reasoning: Optional[str] = None
    producer_tier: Optional[str] = None
    producer_conversion_pct: Optional[float] = None
    producer_tier_reasoning: Optional[str] = None
    meeting_status: Optional[str] = None
    meeting_at: Optional[datetime] = None
    meeting_location: Optional[str] = None
    meeting_notes: Optional[str] = None
    meeting_priority: Optional[int] = None
    # CRM keys filled by AI Sales Agent Data Update — yellow highlight in lists.
    ai_data_update_fields: Optional[list[str]] = None


class LeadTableRowUpdate(BaseModel):
    company_name: Optional[str] = None
    country: Optional[str] = None
    industry: Optional[str] = None
    website_url: Optional[str] = None
    linkedin_company_url: Optional[str] = None
    facebook_company_url: Optional[str] = None
    instagram_company_url: Optional[str] = None
    legacy_serial_no: Optional[int] = None
    company_grading: Optional[str] = None
    product_interest: Optional[str] = None
    city: Optional[str] = None
    address: Optional[str] = None
    remarks: Optional[str] = None
    remarks_03: Optional[str] = None
    remarks_04: Optional[str] = None
    assigned_to: Optional[str] = None
    assigned_to_user_id: Optional[int] = None
    contact_id: Optional[int] = None
    contact_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    contact_designation: Optional[str] = None
    contact_secondary_mobile: Optional[str] = None
    contact_primary_phone: Optional[str] = None
    contact_secondary_phone: Optional[str] = None
    contact_secondary_email: Optional[str] = None
    # AI Research / Auto Data Update: only write into empty cells; never wipe.
    fill_missing_only: Optional[bool] = None


class LeadTableResponse(BaseModel):
    total: int
    filtered_count: int
    page: int = 1
    page_size: int = 20
    total_pages: int = 1
    rows: list[LeadTableRowRead]


class LeadTableIdsResponse(BaseModel):
    filtered_count: int
    ids: list[int]


class ClientHistoryEntryRead(BaseModel):
    id: str
    buyer_id: int
    company_name: str
    country: Optional[str] = None
    assigned_to: Optional[str] = None
    assigned_to_user_id: Optional[int] = None
    text: str
    at: Optional[str] = None
    by: Optional[str] = None
    source: str = "remark"


class ClientHistoryFeedResponse(BaseModel):
    total: int
    page: int
    page_size: int
    total_pages: int
    rows: list[ClientHistoryEntryRead]


class ClientHistoryDetailEntryRead(BaseModel):
    text: str
    at: Optional[str] = None
    by: Optional[str] = None
    source: str = "remark"
    current: bool = False


class ClientHistoryDetailResponse(BaseModel):
    buyer_id: int
    company_name: str
    remarks: Optional[str] = None
    remarks_updated_at: Optional[str] = None
    remarks_updated_by: Optional[str] = None
    entries: list[ClientHistoryDetailEntryRead]


class ClientHistoryAddRequest(BaseModel):
    text: str
    # When True, replace buyers.remarks with this text (and log history).
    append_to_remarks: bool = True


class LeadTableSectionCountsResponse(BaseModel):
    """Sidebar / module badge counts. Extra keys = custom list sources."""

    model_config = ConfigDict(extra="allow")

    all: int
    old_clients: int
    interested_clients: int
    sales_interested_clients: int = 0
    not_interested_clients: int
    not_received_call_clients: int
    master: int = 0
    by_assignee: dict[str, int] = Field(default_factory=dict)
    hyperstore_targeted: int = 0
    targeted_distributor: int = 0
    targeted_client: int = 0
    khalid_focused_sales: int = 0
    incomplete_archives: int = 0
    my_assigned: int = 0
    all_contacts: int = 0
    testing: int = 0
    schedule_meeting: int = 0


class LeadTablePromoteIncompleteArchivesRequest(BaseModel):
    lead_ids: list[int]


class LeadTablePromoteIncompleteArchivesResponse(BaseModel):
    promoted_count: int
    promoted_ids: list[int] = Field(default_factory=list)
    target: str = "old_clients"


class LeadTableSetTargetPoolRequest(BaseModel):
    lead_ids: list[int]
    source: str = Field(min_length=1)
    intake_method: str = "discover"


class LeadTableSetTargetPoolResponse(BaseModel):
    updated_count: int
    updated_ids: list[int] = Field(default_factory=list)


class LeadTablePopulateTargetPoolRequest(BaseModel):
    pool: str = Field(min_length=1)
    from_source: str = Field(description="old_clients, discover, or discover_leads")
    limit: int = Field(default=50, ge=1, le=200)
    min_score: int = Field(default=1, ge=1, le=10)


class LeadTablePopulateTargetPoolResponse(BaseModel):
    updated_count: int
    updated_ids: list[int] = Field(default_factory=list)
    scanned: int = 0
    from_source: str
    pool: str


class LeadTableRemoveFromTargetPoolRequest(BaseModel):
    lead_ids: list[int]


class LeadTableRemoveFromTargetPoolResponse(BaseModel):
    updated_count: int
    updated_ids: list[int] = Field(default_factory=list)


class LeadTableClassifyTargetPoolsRequest(BaseModel):
    limit_per_pool: int = Field(default=5000, ge=1, le=10000)


class LeadTableClassifyTargetPoolsResponse(BaseModel):
    scanned: int
    hyperstore_targeted: dict[str, object] = Field(default_factory=dict)
    targeted_distributor: dict[str, object] = Field(default_factory=dict)


class LeadTableInterestedClientsMembershipRequest(BaseModel):
    lead_ids: list[int]
    in_list: bool = True


class LeadTableInterestedClientsMembershipResponse(BaseModel):
    updated_count: int
    updated_ids: list[int] = Field(default_factory=list)


class DraftListResponse(BaseModel):
    total: int
    page: int = 1
    page_size: int = 20
    total_pages: int = 1
    rows: list[InteractionRead]


class EmailActivityEventRead(BaseModel):
    id: int
    event_type: str
    event_label: str
    severity: str
    title: str
    message: str
    user_id: Optional[int] = None
    user_username: Optional[str] = None
    user_full_name: Optional[str] = None
    buyer_id: Optional[int] = None
    contact_id: Optional[int] = None
    interaction_id: Optional[int] = None
    details: dict[str, Any] = Field(default_factory=dict)
    read_at: Optional[str] = None
    created_at: Optional[str] = None


class EmailActivityListResponse(BaseModel):
    total: int
    unread_count: int
    page: int = 1
    page_size: int = 25
    total_pages: int = 1
    rows: list[EmailActivityEventRead]


class EmailActivityMarkReadRequest(BaseModel):
    event_ids: list[int] = Field(default_factory=list)
    mark_all: bool = False
    # When mark_all=true, limit to this channel ("email" | "whatsapp").
    channel: Optional[str] = None


class EmailActivityCatalogItem(BaseModel):
    event_type: str
    label: str
    description: str
    severity: str


class EmailActivityModeStats(BaseModel):
    attempted: int = 0
    sent: int = 0
    failed: int = 0
    opened: int = 0
    replied: int = 0
    not_opened: int = 0
    open_rate_pct: float = 0.0
    reply_rate_pct: float = 0.0
    success_rate_pct: float = 0.0
    batches: int | None = None
    batches_partial: int | None = None
    batches_failed: int | None = None


class EmailActivityInsights(BaseModel):
    period_days: int | None = None
    since: str | None = None
    until: str | None = None
    tracking_enabled: bool = False
    tracking_base_url: str | None = None
    tracking_pixel_path: str | None = None
    totals: EmailActivityModeStats
    individual: EmailActivityModeStats
    bulk: EmailActivityModeStats
    event_count: int = 0


class EmailActivityAiResponse(BaseModel):
    kind: str
    title: str
    content: str
    stats: EmailActivityInsights | None = None


class LeadTableFiltersRead(BaseModel):
    countries: list[str]
    industries: list[str]
    sources: list[str]
    scores: list[str]
    market_roles: list[str]
    company_gradings: list[str] = []
    products: list[str] = []
    cities: list[str] = []


class LeadScoreRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    buyer_id: int
    score: str
    reasoning: str
    scored_at: datetime


class BuyerProfileRead(BaseModel):
    buyer_id: int
    company_name: str
    website_url: Optional[str]
    country: Optional[str]
    industry: Optional[str]
    website_summary: Optional[str]
    social_summary: Optional[str] = None
    relationship_context: Optional[str]
    signals: list[str]
    matched_categories: list[str] = []
    matched_products: list[dict[str, Any]] = []
    product_fit_score: int = 0
    market_role: str = "unknown"
    market_role_reasoning: Optional[str] = None
    market_role_confidence: Optional[float] = None
    producer_tier: Optional[str] = None
    producer_conversion_pct: Optional[float] = None
    producer_tier_reasoning: Optional[str] = None
    researched_at: Optional[datetime] = None


class DiscoveryRegionRead(BaseModel):
    code: str
    label: str
    group: str
    gl_code: str


class DiscoveryRegionsResponse(BaseModel):
    max_regions: int
    regions: list[DiscoveryRegionRead]


class DiscoverLeadsRequest(BaseModel):
    seed_lead_id: Optional[int] = None
    region_codes: list[str] = Field(default_factory=list, max_length=3)
    country: Optional[str] = None
    industry: Optional[str] = None
    industries: list[str] = Field(default_factory=list, max_length=3)
    categories: list[str] = Field(default_factory=list)
    limit: int = Field(default=15, ge=1, le=15)
    use_web_search: bool = True
    use_website_links: bool = True
    skip_enrichment: bool = False


class DiscoveryCandidateRead(BaseModel):
    candidate_id: str
    company_name: str
    website_url: Optional[str] = None
    contact_name: Optional[str] = None
    email: str = "Not found"
    phone: str = "Not found"
    facebook_url: str = "Not found"
    instagram_url: str = "Not found"
    linkedin_url: str = "Not found"
    country: Optional[str] = None
    industry: Optional[str] = None
    legacy_serial_no: Optional[int] = None
    company_grading: Optional[str] = None
    designation: Optional[str] = None
    secondary_mobile: Optional[str] = None
    primary_phone: Optional[str] = None
    secondary_phone: Optional[str] = None
    secondary_email: Optional[str] = None
    product_interest: Optional[str] = None
    city: Optional[str] = None
    address: Optional[str] = None
    remarks: Optional[str] = None
    source: str
    source_detail: str = ""
    match_reason: str = ""
    already_exists: bool = False
    is_valid_business: bool = True
    invalid_reason: Optional[str] = None


class DiscoverLeadsResponse(BaseModel):
    candidates: list[DiscoveryCandidateRead]
    sources_used: list[str] = Field(default_factory=list)
    messages: list[str] = Field(default_factory=list)
    search_query: Optional[str] = None
    import_parser: Optional[str] = None


class DiscoverImportCandidate(BaseModel):
    company_name: str
    website_url: Optional[str] = None
    contact_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    facebook_url: Optional[str] = None
    instagram_url: Optional[str] = None
    linkedin_url: Optional[str] = None
    country: Optional[str] = None
    industry: Optional[str] = None
    legacy_serial_no: Optional[int] = None
    company_grading: Optional[str] = None
    designation: Optional[str] = None
    secondary_mobile: Optional[str] = None
    primary_phone: Optional[str] = None
    secondary_phone: Optional[str] = None
    secondary_email: Optional[str] = None
    product_interest: Optional[str] = None
    city: Optional[str] = None
    address: Optional[str] = None
    remarks: Optional[str] = None
    source: Optional[str] = "discovery"


class DiscoverImportRequest(BaseModel):
    candidates: list[DiscoverImportCandidate] = Field(min_length=1)
    auto_onboard: bool = False
    replace_duplicates: bool = False
    skip_enrichment: bool = False


class LeadTableDedupeGroup(BaseModel):
    company_name: str
    kept_id: int
    removed_ids: list[int]
    removed_names: list[str] = Field(default_factory=list)


class LeadTableDedupeResponse(BaseModel):
    removed_count: int
    kept_count: int
    groups: list[LeadTableDedupeGroup]


class RemoveOldClientOverlapsResponse(BaseModel):
    removed_count: int
    kept_count: int
    old_clients_count: int
    groups: list[LeadTableDedupeGroup] = Field(default_factory=list)


class LeadTableCleanupResponse(BaseModel):
    removed_count: int
    removed: list[dict[str, Any]] = Field(default_factory=list)


class LeadTableNameRepairResponse(BaseModel):
    scanned: int
    location_name_candidates: int
    repaired_with_name: int
    relocated_name_empty: int
    skipped: int
    dry_run: bool
    samples: list[dict[str, Any]] = Field(default_factory=list)


class LeadTableCompanyCleanResponse(BaseModel):
    scanned: int
    changed: int
    by_rule: dict[str, int] = Field(default_factory=dict)
    dry_run: bool
    samples: list[dict[str, Any]] = Field(default_factory=list)


class PostImportCleanSummary(BaseModel):
    emails_fixed: int = 0
    company_fields_fixed: int = 0
    names_fixed: int = 0
    junk_rows_removed: int = 0
    empty_rows_removed: int = 0
    duplicates_removed: int = 0


class PostImportCleanResponse(BaseModel):
    summary: PostImportCleanSummary
    emails: dict[str, Any] = Field(default_factory=dict)
    company_fields: dict[str, Any] = Field(default_factory=dict)
    names: dict[str, Any] = Field(default_factory=dict)
    junk_removed: dict[str, Any] = Field(default_factory=dict)
    sparse_removed: dict[str, Any] = Field(default_factory=dict)
    dedupe: dict[str, Any] = Field(default_factory=dict)


class LeadTableBulkDeleteRequest(BaseModel):
    lead_ids: list[int]


class LeadTableBulkDeleteResponse(BaseModel):
    deleted_count: int
    deleted_ids: list[int]


class LeadTableBulkAssignRequest(BaseModel):
    lead_ids: list[int]
    assigned_to_user_id: Optional[int] = None


class LeadTableBulkAssignResponse(BaseModel):
    assigned_count: int
    assigned_ids: list[int]
    assigned_to_user_id: Optional[int] = None
    assigned_to: str = "unassigned"
    transfer_message: Optional[str] = None


class DiscoverImportResponse(BaseModel):
    created_count: int
    skipped_count: int
    replaced_count: int = 0
    created: list[BuyerRead]
    skipped: list[dict[str, str]]
    replaced: list[dict[str, Any]] = Field(default_factory=list)
    onboard_results: list[dict[str, Any]] = Field(default_factory=list)


class ImportJobStartResponse(BaseModel):
    job_id: str
    total: int


class ImportJobStatusResponse(BaseModel):
    job_id: str
    status: str  # queued | running | committing | verifying | completed | failed
    phase_label: str = ""
    total: int
    processed: int
    created_count: int
    skipped_count: int
    replaced_count: int
    current_company: Optional[str] = None
    error: Optional[str] = None
    import_source: Optional[str] = None
    # Total rows in the DB with this source after the import commits — proof
    # the leads actually landed in the table.
    verified_source_total: Optional[int] = None
    created: Optional[list[dict[str, Any]]] = None
    skipped: Optional[list[dict[str, str]]] = None
    replaced: Optional[list[dict[str, Any]]] = None
    elapsed_seconds: float = 0.0


class SynthesisJobStartResponse(BaseModel):
    job_id: str
    file_count: int
    upload_count: int = 0


class SynthesisJobStatusResponse(BaseModel):
    job_id: str
    status: str
    phase: str = ""
    phase_label: str = ""
    total: int = 0
    processed: int = 0
    percent: int = 0
    raw_rows: int = 0
    output_rows: int = 0
    merged_duplicates: int = 0
    skipped_existing: int = 0
    sheets_processed: int = 0
    files_processed: int = 0
    current_company: Optional[str] = None
    messages: list[str] = Field(default_factory=list)
    error: Optional[str] = None
    output_filename: Optional[str] = None
    elapsed_seconds: float = 0.0


class CallConfigRead(BaseModel):
    configured: bool
    webhooks_ready: bool
    browser_ready: bool = False
    caller_id_masked: Optional[str] = None
    setup_message: Optional[str] = None
    missing_env: list[str] = Field(default_factory=list)
    twilio_account_sid: Optional[str] = None
    twilio_twiml_app_sid: Optional[str] = None
    twilio_webhook_base_url: Optional[str] = None
    twilio_validate_webhooks: bool = True


class TwilioBalanceRead(BaseModel):
    configured: bool
    caller_id_masked: Optional[str] = None
    twilio_account_sid: Optional[str] = None
    ok: bool
    balance: Optional[float] = None
    currency: Optional[str] = None
    message: Optional[str] = None
    fetched_at: Optional[str] = None
    hangup_after_fourth_ring: bool = True
    ring_timeout_seconds: int = 16
    max_ring_attempts: int = 10


class VoiceTokenRead(BaseModel):
    token: str
    identity: str


class CallInitiateRequest(BaseModel):
    contact_id: Optional[int] = None
    phone: Optional[str] = None


class ManualCallRequest(BaseModel):
    phone: str
    contact_name: Optional[str] = None
    country: Optional[str] = None


class CallInitiateResponse(InteractionRead):
    call_sid: Optional[str] = None
    call_status: Optional[str] = None
    lead_phone: Optional[str] = None
    message: Optional[str] = None


class CallHistoryItem(BaseModel):
    id: int
    contact_id: int
    buyer_id: Optional[int] = None
    company_name: Optional[str] = None
    contact_name: Optional[str] = None
    contact_phone: Optional[str] = None
    channel: str = "phone"
    direction: str
    subject: Optional[str] = None
    content: Optional[str] = None
    status: str
    created_at: datetime
    call_sid: Optional[str] = None
    call_status: Optional[str] = None
    call_duration_seconds: Optional[int] = None
    lead_phone: Optional[str] = None
    notes: Optional[str] = None
    call_outcome: Optional[str] = None
    recording_available: bool = False
    recording_sid: Optional[str] = None
    recording_duration_seconds: Optional[int] = None
    recording_url: Optional[str] = None
    download_url: Optional[str] = None
    transcript: Optional[str] = None
    transcript_status: Optional[str] = None
    transcript_error: Optional[str] = None
    ai_training_selected: bool = False


class CallHistoryListResponse(BaseModel):
    total: int
    page: int = 1
    page_size: int = 5
    total_pages: int = 1
    since_days: Optional[int] = 30
    rows: list[CallHistoryItem]


class DialablePhoneOption(BaseModel):
    index: int
    label: str
    phone: str
    contact_id: Optional[int] = None


class DialableLeadRow(BaseModel):
    id: int
    company_name: str
    country: Optional[str] = None
    call_recommended: Optional[bool] = None
    call_local_time: Optional[str] = None
    call_timezone: Optional[str] = None
    call_reason: Optional[str] = None
    contact_id: Optional[int] = None
    contact_name: Optional[str] = None
    contact_phone: Optional[str] = None
    phones: list[DialablePhoneOption] = Field(default_factory=list)
    possible_duplicate: bool = False
    missing_contact_name: bool = False


class DialableCountryNow(BaseModel):
    country: str
    local_time: str = ""
    timezone: str = ""


class DialableLeadsResponse(BaseModel):
    total: int
    page: int = 1
    page_size: int = 25
    total_pages: int = 1
    rows: list[DialableLeadRow]
    countries: list[str] = Field(default_factory=list)
    countries_valid_now: list[DialableCountryNow] = Field(default_factory=list)


class CallNotesRequest(BaseModel):
    notes: str = ""
    call_outcome: Optional[str] = None


class InterestedFollowUpRead(BaseModel):
    id: str
    buyer_id: int
    company_name: str
    contact_name: Optional[str] = None
    interested_at: datetime
    weeks_since_placement: int = 0
    days_since_placement: int = 0
    due_at: datetime
    call_outcome: Optional[str] = None
    table_section: Optional[str] = None


class InterestedFollowUpAckRead(BaseModel):
    buyer_id: int
    interested_follow_up_ack_at: datetime
    follow_up_at: Optional[datetime] = None


class FollowUpAtUpdate(BaseModel):
    follow_up_at: Optional[datetime] = None


class FollowUpAtRead(BaseModel):
    buyer_id: int
    follow_up_at: Optional[datetime] = None


# ── Inbox (Outlook) ───────────────────────────────────────────────────────────


class InboxMailboxStatus(BaseModel):
    provider: str
    email: Optional[str] = None
    configured: bool = True


class InboxStatus(BaseModel):
    configured: bool
    email: Optional[str] = None
    emails: list[str] = Field(default_factory=list)
    mailboxes: list[InboxMailboxStatus] = Field(default_factory=list)
    unread_count: int = 0
    showing_since: Optional[str] = None


class InboxUnreadCount(BaseModel):
    count: int


class InboxAttachment(BaseModel):
    filename: Optional[str] = None
    size: Optional[int] = None
    content_type: Optional[str] = None


class InboxMessageSummary(BaseModel):
    uid: str
    folder: str = "INBOX"
    provider: Optional[str] = None
    subject: str
    from_email: Optional[str] = None
    from_name: Optional[str] = None
    to: list[str] = Field(default_factory=list)
    cc: list[str] = Field(default_factory=list)
    bcc: list[str] = Field(default_factory=list)
    date: Optional[datetime] = None
    preview: str = ""
    unread: bool = False
    has_attachments: bool = False
    message_id: Optional[str] = None
    in_reply_to: Optional[str] = None
    references: Optional[str] = None
    direction: str = "inbound"


class InboxMessageDetail(InboxMessageSummary):
    body_text: Optional[str] = None
    body_html: Optional[str] = None
    attachments: list[InboxAttachment] = Field(default_factory=list)


class InboxThreadSummary(BaseModel):
    thread_id: str
    subject: str
    participants: list[str] = Field(default_factory=list)
    message_count: int = 1
    unread_count: int = 0
    latest_date: Optional[datetime] = None
    latest_preview: str = ""
    latest_from_email: Optional[str] = None
    latest_from_name: Optional[str] = None
    has_attachments: bool = False
    provider: Optional[str] = None
    triage_category: Optional[str] = None
    triage_label: Optional[str] = None


class InboxThreadListResponse(BaseModel):
    items: list[InboxThreadSummary] = Field(default_factory=list)
    total: int = 0
    offset: int = 0
    limit: int = 50
    has_more: bool = False


class InboxMessageListResponse(BaseModel):
    items: list[InboxMessageSummary] = Field(default_factory=list)
    total: int = 0
    offset: int = 0
    limit: int = 50
    has_more: bool = False


class InboxMailSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=200)
    scope: str = Field(
        default="inbox",
        description="inbox | sent | trash | archive | all | label:<id>",
    )
    limit: int = Field(default=50, ge=1, le=100)
    offset: int = Field(default=0, ge=0)


class InboxMailAiQueryRequest(BaseModel):
    question: str = Field(min_length=2, max_length=500)
    unread_only: bool = False


class InboxMailAiQueryResponse(BaseModel):
    answer: str
    suggested_threads: list[InboxThreadSummary] = Field(default_factory=list)
    unread_count: int = 0


class InboxThreadDetail(InboxThreadSummary):
    messages: list[InboxMessageDetail] = Field(default_factory=list)


class InboxReplyRequest(BaseModel):
    body: str = Field(min_length=1)
    to: Optional[str] = None
    subject: Optional[str] = None
    cc: Optional[str] = None
    bcc: Optional[str] = None
    folder: Optional[str] = "INBOX"
    attachments: Optional[list[dict[str, Any]]] = None


class InboxReplyResponse(BaseModel):
    status: str
    message: str
    to: Optional[str] = None
    subject: Optional[str] = None


class InboxComposeRequest(BaseModel):
    to: str = Field(min_length=3, description="Recipient email address")
    subject: str = Field(default="", description="Email subject")
    body: str = Field(min_length=1, description="Plain-text email body")
    cc: Optional[str] = None
    bcc: Optional[str] = None
    attachments: Optional[list[dict[str, Any]]] = None


class InboxComposeResponse(BaseModel):
    status: str
    message: str
    to: Optional[str] = None
    subject: Optional[str] = None
    from_email: Optional[str] = None


class InboxAnalyzeRequest(BaseModel):
    goal: Optional[str] = Field(
        default=None,
        description="Optional instruction for the draft, e.g. politely decline / ask for specs",
    )
    folder: Optional[str] = Field(
        default="INBOX",
        description="IMAP folder for single-message analyze",
    )


class InboxAnalyzeResponse(BaseModel):
    summary: str
    draft_reply: str
    suggested_subject: Optional[str] = None
    to: Optional[str] = None
    source: str = "llm"


class InboxFolderInfo(BaseModel):
    key: str
    imap_name: Optional[str] = None
    available: bool = False
    count: int = 0
    unread_count: int = 0


class InboxFoldersResponse(BaseModel):
    configured: bool
    folders: list[InboxFolderInfo] = Field(default_factory=list)


class InboxMoveRequest(BaseModel):
    from_folder: str = Field(min_length=1, description="IMAP folder name the message is currently in")
    to_folder: str = Field(
        min_length=1,
        description="Logical destination: inbox | sent | trash | archive",
    )


class InboxMoveResponse(BaseModel):
    status: str
    message: str
    from_folder: Optional[str] = None
    to_folder: Optional[str] = None
    to_folder_key: Optional[str] = None
    moved_count: int = 0


class InboxEmptyTrashResponse(BaseModel):
    status: str
    message: str
    deleted_count: int = 0


class InboxThreadMoveRequest(BaseModel):
    to_folder: str = Field(
        min_length=1,
        description="Logical destination: inbox | trash | archive",
    )


# ── Daily KPI Generation ──────────────────────────────────────────────────────


class KpiUserBrief(BaseModel):
    id: int
    username: str
    full_name: str
    role: str


class KpiCounts(BaseModel):
    calls_logged: int = 0
    companies_called: int = 0
    outcomes_interested: int = 0
    outcomes_follow_up: int = 0
    outcomes_not_interested: int = 0
    outcomes_not_received_call: int = 0
    call_remarks: int = 0
    leads_imported: int = 0
    table_edits: int = 0
    email_templates_created: int = 0
    personal_emails_sent: int = 0
    emails_after_calls: int = 0
    emails_other_personal: int = 0
    bulk_emails_sent: int = 0
    personal_whatsapp_sent: int = 0
    bulk_whatsapp_sent: int = 0
    inbox_replies: int = 0
    brand_assistant_sessions: int = 0


class KpiActivityItem(BaseModel):
    id: int
    user_id: int
    username: Optional[str] = None
    full_name: Optional[str] = None
    activity_type: str
    title: str
    summary: str
    quantity: int = 1
    entity_type: Optional[str] = None
    entity_id: Optional[int] = None
    details: Optional[dict] = None
    created_at: datetime
    # Enriched metadata for clickable KPI drill-down views
    company_name: Optional[str] = None
    contact_name: Optional[str] = None
    contact_designation: Optional[str] = None
    country: Optional[str] = None
    phone: Optional[str] = None
    outcome: Optional[str] = None
    remarks: Optional[str] = None
    duration_seconds: Optional[int] = None


class KpiPerUserSummary(BaseModel):
    user: Optional[KpiUserBrief] = None
    counts: KpiCounts
    activity_count: int = 0


class DailyKpiReportRead(BaseModel):
    date: str
    period: str = "day"
    date_start: Optional[str] = None
    date_end: Optional[str] = None
    timezone: str
    scope: str
    user: Optional[KpiUserBrief] = None
    counts: KpiCounts
    email_attribution_note: Optional[str] = None
    per_user: list[KpiPerUserSummary] = Field(default_factory=list)
    activities: list[KpiActivityItem] = Field(default_factory=list)
    activity_count: int = 0


class KpiSummaryRequest(BaseModel):
    date: date
    period: str = "day"
    user_id: Optional[int] = None


class KpiSummaryResponse(BaseModel):
    summary: str
    source: str
    subject: str
    report: DailyKpiReportRead


class ManualKpiEntryRead(BaseModel):
    id: int
    user_id: int
    username: Optional[str] = None
    full_name: Optional[str] = None
    activity_date: str
    person_name: Optional[str] = None
    company: Optional[str] = None
    country: Optional[str] = None
    contact_type: Optional[str] = None
    follow_up_type: Optional[str] = None
    wechat_contacts: Optional[str] = None
    remarks: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class ManualKpiEntryCreate(BaseModel):
    activity_date: date
    person_name: Optional[str] = None
    company: Optional[str] = None
    country: Optional[str] = None
    contact_type: Optional[str] = None
    follow_up_type: Optional[str] = None
    wechat_contacts: Optional[str] = None
    remarks: Optional[str] = None


class ManualKpiEntryUpdate(BaseModel):
    activity_date: Optional[date] = None
    person_name: Optional[str] = None
    company: Optional[str] = None
    country: Optional[str] = None
    contact_type: Optional[str] = None
    follow_up_type: Optional[str] = None
    wechat_contacts: Optional[str] = None
    remarks: Optional[str] = None


class ManualKpiListResponse(BaseModel):
    items: list[ManualKpiEntryRead] = Field(default_factory=list)
    total: int = 0
    period: str = "day"
    date_start: str
    date_end: str
    timezone: str = "Asia/Karachi"
    scope: str = "user"


# ── WhatsApp Cloud API ────────────────────────────────────────────────────────


class WhatsAppConfigRead(BaseModel):
    configured: bool
    webhook_configured: bool
    phone_number_id_set: bool
    business_account_id_set: bool
    app_secret_set: bool = False
    display_number: Optional[str] = None
    missing_env: list[str] = Field(default_factory=list)
    meta_api_ok: Optional[bool] = None
    meta_api_message: Optional[str] = None
    webhook_callback_url: Optional[str] = None
    webhook_verify_token_set: bool = False
    ready_for_two_way: bool = False
    cloud_sending_enabled: bool = False
    cloud_sending_paused_message: Optional[str] = None
    phone_number_id_mismatch: Optional[str] = None
    webhook_phone_number_id: Optional[str] = None
    webhook_display_phone_number: Optional[str] = None


class WhatsAppTestSendRequest(BaseModel):
    """Send a one-off test message via Cloud API (admin)."""

    phone: str = Field(..., min_length=8, max_length=32)
    message: str = Field(
        default="Hello from Kafi Sales Agent — WhatsApp Cloud API test.",
        min_length=1,
        max_length=4096,
    )
    template_name: Optional[str] = None
    template_language: str = "en_US"


class WhatsAppTestSendResponse(BaseModel):
    status: str
    message: str
    to: Optional[str] = None
    provider_message_id: Optional[str] = None


class WhatsAppTemplateRead(BaseModel):
    id: int
    meta_template_id: Optional[str] = None
    name: str
    category: Optional[str] = None
    language: str
    status: str
    body_text: Optional[str] = None
    variable_count: int = 0
    submitted_by_user_id: Optional[int] = None
    rejection_reason: Optional[str] = None
    synced_at: datetime


class WhatsAppTemplateCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=512)
    category: Literal["MARKETING", "UTILITY", "AUTHENTICATION"] = "UTILITY"
    language: str = Field(default="en_US", min_length=2, max_length=20)
    body: str = Field(min_length=1, max_length=1024)
    footer: Optional[str] = Field(default=None, max_length=60)


class WhatsAppTemplateCreateResponse(BaseModel):
    template: WhatsAppTemplateRead
    message: str
    meta_status: str = "PENDING"


class WhatsAppTemplateResubmitRequest(BaseModel):
    body: str = Field(min_length=1, max_length=1024)
    footer: Optional[str] = Field(default=None, max_length=60)
    category: Optional[Literal["MARKETING", "UTILITY", "AUTHENTICATION"]] = None


class WhatsAppTemplateNotificationRead(BaseModel):
    id: int
    template_id: int
    event_type: str
    message: str
    read_at: Optional[datetime] = None
    created_at: datetime


class WhatsAppTemplateNotificationsResponse(BaseModel):
    unread_count: int
    rows: list[WhatsAppTemplateNotificationRead]


class WhatsAppTemplateNotificationsReadRequest(BaseModel):
    notification_ids: Optional[list[int]] = None


class WhatsAppTemplateSyncResponse(BaseModel):
    status: str
    message: str
    synced_count: int = 0


class WhatsAppTemplateDeleteResponse(BaseModel):
    status: str
    message: str


class WhatsAppCampaignDraftRequest(BaseModel):
    template_id: int
    buyer_ids: list[int] = Field(min_length=1)
    template_variables: list[str] = Field(default_factory=list)
    require_opt_in: bool = True
    send: bool = True
    # When sending to one lead from the compose modal, use this exact WhatsApp number.
    to_phone: Optional[str] = None


class WhatsAppCampaignDraftResultItem(BaseModel):
    buyer_id: int
    company_name: str
    interaction_id: int
    contact_id: int
    sent: bool = False
    send_status: Optional[str] = None
    send_message: Optional[str] = None


class WhatsAppCampaignSkippedItem(BaseModel):
    buyer_id: int
    company_name: Optional[str] = None
    reason: str


class WhatsAppCampaignDraftResponse(BaseModel):
    created_count: int
    skipped_count: int
    sent_count: int = 0
    failed_count: int = 0
    delivery_error: Optional[str] = None
    created: list[WhatsAppCampaignDraftResultItem]
    skipped: list[WhatsAppCampaignSkippedItem]


class WhatsAppConversationRead(BaseModel):
    contact_id: int
    buyer_id: int
    company_name: Optional[str] = None
    contact_name: Optional[str] = None
    contact_phone: Optional[str] = None
    whatsapp_opt_in: bool = False
    within_session_window: bool = False
    window_expires_at: Optional[datetime] = None
    last_message: Optional[str] = None
    last_message_at: Optional[datetime] = None
    last_direction: Optional[str] = None
    unread_count: int = 0


class WhatsAppConversationListResponse(BaseModel):
    total: int
    page: int = 1
    page_size: int = 20
    total_pages: int = 1
    rows: list[WhatsAppConversationRead]


class WhatsAppBuyerPreviewResponse(BaseModel):
    """Short WhatsApp thread snippet for the buyer profile page."""

    buyer_id: int
    contact_id: Optional[int] = None
    contact_name: Optional[str] = None
    contact_phone: Optional[str] = None
    within_session_window: bool = False
    total_messages: int = 0
    messages: list[InteractionRead] = Field(default_factory=list)


class WhatsAppReplyRequest(BaseModel):
    content: str
    send: bool = True
    template_name: Optional[str] = None
    template_language: Optional[str] = "en_US"
    template_variables: list[str] = Field(default_factory=list)
    # Optional override — UI should pass the conversation phone / Meta wa_id.
    to_phone: Optional[str] = None


class WhatsAppReplyResponse(BaseModel):
    interaction: InteractionRead
    sent: bool
    send_status: Optional[str] = None
    send_message: Optional[str] = None
    needs_template: bool = False
