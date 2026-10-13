from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pathlib import Path
from datetime import datetime
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db, require_admin
from db.models import AppUser, AppUserRole, LeadScoreLabel
from api.schemas import (
    BuyerCreate,
    BuyerListResponse,
    BuyerProfileRead,
    BuyerRead,
    CompanyNameSuggestion,
    CompanyNameSuggestionsResponse,
    ContactCreate,
    ContactRead,
    ContactUpdate,
    DiscoverImportRequest,
    DiscoverImportResponse,
    DiscoverLeadsRequest,
    DiscoverLeadsResponse,
    DiscoveryCandidateRead,
    DiscoveryRegionsResponse,
    ImportJobStartResponse,
    ImportJobStatusResponse,
    InteractionRead,
    LeadScoreRead,
    LeadTableCleanupResponse,
    LeadTableCompanyCleanResponse,
    PostImportCleanResponse,
    LeadTableNameRepairResponse,
    LeadTableDedupeResponse,
    RemoveOldClientOverlapsResponse,
    LeadTableBulkDeleteRequest,
    LeadTableBulkDeleteResponse,
    LeadTableBulkAssignRequest,
    LeadTableBulkAssignResponse,
    LeadTableInterestedClientsMembershipRequest,
    LeadTableInterestedClientsMembershipResponse,
    LeadTableFiltersRead,
    LeadTableIdsResponse,
    LeadTableResponse,
    LeadTableRowRead,
    LeadTableRowUpdate,
    LeadTableSectionCountsResponse,
    LeadTableSetTargetPoolRequest,
    LeadTableSetTargetPoolResponse,
    LeadTablePopulateTargetPoolRequest,
    LeadTablePopulateTargetPoolResponse,
    LeadTableRemoveFromTargetPoolRequest,
    LeadTableRemoveFromTargetPoolResponse,
    LeadTableClassifyTargetPoolsRequest,
    LeadTableClassifyTargetPoolsResponse,
    LeadTablePromoteIncompleteArchivesRequest,
    LeadTablePromoteIncompleteArchivesResponse,
    ProductInterestEmailRequest,
    QuotationEligibleLeadRead,
    InterestedFollowUpAckRead,
    InterestedFollowUpRead,
    FollowUpAtUpdate,
    FollowUpAtRead,
    ClientHistoryFeedResponse,
    ClientHistoryDetailResponse,
    ClientHistoryAddRequest,
)
from modules.comms_generator import get_comms
from modules import buyers as buyers_module
from modules import leads as leads_module
from modules.audit import log_action
from modules.lead_discovery import (
    OLD_CLIENTS_IMPORT_PARSER,
    _existing_buyer_keys,
    _import_scope_for_source,
    _mark_existing,
    discover_from_csv,
    discover_leads,
    enrich_discovery_candidate,
    discovery_candidate_from_dict,
    import_candidates,
)
from modules.file_to_csv import SUPPORTED_UPLOAD_EXTENSIONS, convert_upload_to_csv
from modules.discovery_regions import list_discovery_regions


def _is_admin(user: AppUser) -> bool:
    role = user.role.value if isinstance(user.role, AppUserRole) else str(user.role)
    return role == AppUserRole.admin.value


def _assignee_scope(user: AppUser) -> int | None:
    """Personal follow-up scope — non-admins only see their own assigned leads."""
    return None if _is_admin(user) else user.id


def _team_read_scope(user: AppUser) -> int | None:
    """Read scope for feeds (client history, etc.). Non-admins only see assigned leads."""
    return None if _is_admin(user) else user.id


def _table_assignment_filters(
    user: AppUser,
    *,
    assigned_to_user_id: int | None,
    my_assigned: bool = False,
    call_outcome: str | None,
    source: str | None,
    exclude_source: str | None,
    master: bool = False,
    in_interested_clients: bool = False,
) -> tuple[int | None, bool, bool, int | None, bool]:
    """Resolve assignee scope for leads-table list/count queries."""
    if not _is_admin(user):
        # Non-admin sales user (e.g. Asim): strictly force their assigned user ID scope.
        return (user.id, False, True, None, False)

    placed_section = bool(call_outcome) or in_interested_clients

    if master:
        # Every lead (assigned + unassigned, all sources).
        return None, False, True, None, False

    if my_assigned:
        # Sales user's "Assigned" list — every lead assigned to them (incl. self-imports).
        return (user.id, False, True, None, False)

    if assigned_to_user_id is not None:
        # "Leads Sent To {username}" — only admin-sent leads.
        return (
            assigned_to_user_id,
            False,
            (not placed_section) and not source and not exclude_source,
            None,
            True,
        )
    # Old clients & Incomplete archives & Targeted pools & Custom modules: show every row.
    norm_source = (source or "").strip().lower()
    if norm_source and norm_source not in {"all", "new_search_lead"}:
        return None, False, True, None, False
    # Other pool sections (New search lead): hide assigned leads.
    unassigned_only = not placed_section
    return None, unassigned_only, False, None, False


def _require_buyer_access(db, user: AppUser, buyer_id: int) -> None:
    if not leads_module.user_can_access_buyer(db, user=user, buyer_id=buyer_id):
        raise HTTPException(403, "You do not have access to this lead")


router = APIRouter(prefix="/leads", tags=["leads"])


@router.get("", response_model=BuyerListResponse)
def list_leads(
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Discover Leads list — excludes old_clients (those live only in Old clients)."""
    assigned_id = None if _is_admin(user) else user.id
    return leads_module.list_buyers_with_scores(
        db,
        page=page,
        page_size=page_size,
        exclude_source="old_clients",
        assigned_to_user_id=assigned_id,
    )


@router.get("/company-suggestions", response_model=CompanyNameSuggestionsResponse)
def company_name_suggestions(
    q: str = Query("", min_length=0, max_length=200),
    limit: int = Query(12, ge=1, le=25),
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
):
    """Autocomplete company names from the master buyers table (all sections)."""
    assigned_id = None if _is_admin(_user) else _user.id
    rows = leads_module.suggest_company_names(db, q=q, limit=limit, assigned_to_user_id=assigned_id)
    return CompanyNameSuggestionsResponse(
        q=q.strip(),
        rows=[CompanyNameSuggestion(**row) for row in rows],
    )


@router.post("", response_model=BuyerRead, status_code=201)
def create_lead(
    payload: BuyerCreate,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    buyer = buyers_module.create_buyer(db, payload.model_dump())
    # Sales users own what they create; admin creates stay in the shared pool
    # until explicitly sent via "Leads Sent To".
    if not _is_admin(user):
        leads_module.apply_buyer_assignee(db, buyer, user.id)
        db.commit()
        db.refresh(buyer)
    log_action(db, entity_type="buyer", entity_id=buyer.id, action="created")
    return buyer


@router.post("/contacts", response_model=ContactRead, status_code=201)
def create_contact(payload: ContactCreate, db: Session = Depends(get_db)):
    if not buyers_module.get_buyer(db, payload.buyer_id):
        raise HTTPException(404, "Lead not found")
    contact = buyers_module.create_contact(db, payload.model_dump())
    log_action(
        db,
        entity_type="contact",
        entity_id=contact.id,
        action="created",
        details={"buyer_id": contact.buyer_id},
    )
    return buyers_module.contact_to_read(contact)


@router.patch("/contacts/{contact_id}", response_model=ContactRead)
def update_contact(
    contact_id: int,
    payload: ContactUpdate,
    db: Session = Depends(get_db),
):
    existing = buyers_module.get_contact(db, contact_id)
    if not existing:
        raise HTTPException(404, "Contact not found")
    contact = buyers_module.update_contact(
        db, contact_id, payload.model_dump(exclude_unset=True)
    )
    if not contact:
        raise HTTPException(404, "Contact not found")
    log_action(
        db,
        entity_type="contact",
        entity_id=contact.id,
        action="updated",
        details={"buyer_id": contact.buyer_id},
    )
    return buyers_module.contact_to_read(contact)


@router.delete("/contacts/{contact_id}", status_code=204)
def delete_contact(contact_id: int, db: Session = Depends(get_db)):
    contact = buyers_module.get_contact(db, contact_id)
    if not contact:
        raise HTTPException(404, "Contact not found")
    buyer_id = contact.buyer_id
    if not buyers_module.delete_contact(db, contact_id):
        raise HTTPException(404, "Contact not found")
    log_action(
        db,
        entity_type="contact",
        entity_id=contact_id,
        action="deleted",
        details={"buyer_id": buyer_id},
    )


@router.get("/{lead_id}/contacts", response_model=list[ContactRead])
def list_lead_contacts(lead_id: int, db: Session = Depends(get_db)):
    if not buyers_module.get_buyer(db, lead_id):
        raise HTTPException(404, "Lead not found")
    contacts = buyers_module.list_contacts_for_buyer(db, lead_id)
    return [buyers_module.contact_to_read(contact) for contact in contacts]


@router.get("/{lead_id}/dial-phones")
def list_lead_dial_phones(lead_id: int, db: Session = Depends(get_db)):
    """All dialable numbers for a lead (main, primary, mobile 2, phone 2, across contacts)."""
    from modules import calls as calls_module

    if not buyers_module.get_buyer(db, lead_id):
        raise HTTPException(404, "Lead not found")
    return {"phones": calls_module.dial_phone_options_for_buyer(db, lead_id)}


@router.post("/{lead_id}/product-interest-email", response_model=InteractionRead)
def create_product_interest_email(
    lead_id: int,
    payload: ProductInterestEmailRequest,
    db: Session = Depends(get_db),
):
    buyer = buyers_module.get_buyer(db, lead_id)
    if not buyer:
        raise HTTPException(404, "Lead not found")

    score = leads_module.get_latest_score(db, lead_id)
    if not score:
        raise HTTPException(400, "Lead must be scored before drafting outreach")
    if score.score not in (LeadScoreLabel.AAAA, LeadScoreLabel.AAA, LeadScoreLabel.AA):
        raise HTTPException(400, "Product interest emails are for AAAA, AAA, or AA graded companies only")

    from db.models import MarketRole, ProducerTier

    if buyer.market_role == MarketRole.producer:
        if buyer.producer_tier != ProducerTier.weak or (
            buyer.producer_conversion_pct is None or float(buyer.producer_conversion_pct) < 40
        ):
            raise HTTPException(
                400,
                "Strong producers are competitors. Weak producers need ≥40% conversion potential for outreach.",
            )

    contacts = buyers_module.list_contacts_for_buyer(db, lead_id)
    if not contacts:
        raise HTTPException(400, "Add a contact with an email address first")

    contact = None
    if payload.contact_id:
        contact = next((c for c in contacts if c.id == payload.contact_id), None)
        if not contact:
            raise HTTPException(400, "Contact not found for this lead")
    else:
        contact = next((c for c in contacts if c.email), contacts[0])

    if not contact.email:
        raise HTTPException(400, "Contact has no email address")

    products = [p.model_dump() for p in payload.products]
    try:
        draft = get_comms().generate_product_interest_email(
            db,
            contact_id=contact.id,
            products=products,
            attachments=[a.model_dump() for a in payload.attachments],
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    log_action(
        db,
        entity_type="interaction",
        entity_id=draft.id,
        action="product_interest_draft_created",
        details={"buyer_id": lead_id, "product_count": len(products)},
    )
    return draft


@router.get("/quotation-eligible", response_model=list[QuotationEligibleLeadRead])
def list_quotation_eligible_leads(db: Session = Depends(get_db)):
    return leads_module.list_quotation_eligible_leads(db)


@router.get("/interested-follow-ups", response_model=list[InterestedFollowUpRead])
def list_interested_follow_ups(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules.interested_follow_ups import list_due_follow_ups

    return list_due_follow_ups(db, assigned_to_user_id=_assignee_scope(user))


@router.get("/client-history", response_model=ClientHistoryFeedResponse)
def list_client_history(
    buyer_id: int | None = None,
    search: str | None = None,
    page: int = 1,
    page_size: int = 50,
    date_from: str | None = None,
    date_to: str | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import client_history as client_history_module

    return client_history_module.list_client_history_feed(
        db,
        assigned_to_user_id=_team_read_scope(user),
        buyer_id=buyer_id,
        search=search,
        page=page,
        page_size=page_size,
        date_from=date_from,
        date_to=date_to,
    )


@router.get("/{lead_id}/client-history", response_model=ClientHistoryDetailResponse)
def get_client_history(
    lead_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import client_history as client_history_module

    _require_buyer_access(db, user, lead_id)
    detail = client_history_module.history_for_buyer(db, lead_id)
    if not detail:
        raise HTTPException(404, "Lead not found")
    return detail


@router.post("/{lead_id}/client-history", response_model=ClientHistoryDetailResponse)
def add_client_history_remark(
    lead_id: int,
    payload: ClientHistoryAddRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import client_history as client_history_module

    _require_buyer_access(db, user, lead_id)
    try:
        detail = client_history_module.add_client_remark(
            db,
            lead_id,
            payload.text,
            by_username=user.username,
            append_to_remarks=payload.append_to_remarks,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not detail:
        raise HTTPException(404, "Lead not found")
    return detail


@router.post(
    "/interested-follow-ups/{buyer_id}/acknowledge",
    response_model=InterestedFollowUpAckRead,
)
def acknowledge_interested_follow_up(
    buyer_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules.interested_follow_ups import acknowledge_follow_up

    _require_buyer_access(db, user, buyer_id)
    try:
        return acknowledge_follow_up(db, buyer_id=buyer_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.patch(
    "/interested-follow-ups/{buyer_id}",
    response_model=FollowUpAtRead,
)
def schedule_interested_follow_up(
    buyer_id: int,
    payload: FollowUpAtUpdate,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules.interested_follow_ups import set_follow_up_at

    _require_buyer_access(db, user, buyer_id)
    try:
        return set_follow_up_at(
            db,
            buyer_id=buyer_id,
            follow_up_at=payload.follow_up_at,
            by_user_id=user.id,
            by_username=user.username,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/product-types")
def list_product_types():
    from modules.product_catalog import list_unique_product_types

    types = list_unique_product_types()
    return {"count": len(types), "product_types": types}


@router.get("/table/filters", response_model=LeadTableFiltersRead)
def get_leads_table_filters(
    source: str | None = None,
    db: Session = Depends(get_db),
):
    return LeadTableFiltersRead(**leads_module.get_lead_table_filters(db, source=source))


@router.get("/table", response_model=LeadTableResponse)
def list_leads_table(
    score: str | None = None,
    country: str | None = None,
    industry: str | None = None,
    company_grading: str | None = None,
    product_interest: str | None = None,
    city: str | None = None,
    call_recommended: str | None = None,
    source: str | None = None,
    exclude_source: str | None = None,
    call_outcome: str | None = None,
    in_interested_clients: bool = False,
    market_role: str | None = None,
    q: str | None = None,
    sort_by: str = "company_name",
    sort_dir: str = "asc",
    page: int = 1,
    page_size: int = 20,
    assigned_to_user_id: int | None = None,
    my_assigned: bool = False,
    master: bool = False,
    intake_method: str | None = None,
    new_search_lead_only: bool = False,
    master_type: str | None = None,
    all_contacts: bool = False,
    designation: str | None = None,
    contact_person: str | None = None,
    primary_mobile: str | None = None,
    secondary_mobile: str | None = None,
    phone: str | None = None,
    secondary_phone: str | None = None,
    email: str | None = None,
    secondary_email: str | None = None,
    website: str | None = None,
    address: str | None = None,
    remarks: str | None = None,
    assigned_to_filter: str | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    assignee_id, unassigned_only, include_placed, pool_for_user_id, admin_sent_only = (
        _table_assignment_filters(
            user,
            assigned_to_user_id=assigned_to_user_id,
            my_assigned=my_assigned or all_contacts,
            call_outcome=call_outcome,
            source=source,
            exclude_source=exclude_source,
            master=master,
            in_interested_clients=in_interested_clients,
        )
    )
    result = leads_module.list_leads_table(
        db,
        score=score,
        country=country,
        industry=industry,
        company_grading=company_grading,
        product_interest=product_interest,
        city=city,
        call_recommended=call_recommended,
        source=source,
        exclude_source=exclude_source,
        call_outcome=call_outcome,
        in_interested_clients=in_interested_clients,
        market_role=market_role,
        q=q,
        sort_by=sort_by,
        sort_dir=sort_dir,
        page=page,
        page_size=page_size,
        assigned_to_user_id=assignee_id,
        unassigned_only=unassigned_only,
        pool_for_user_id=pool_for_user_id,
        include_placed_outcomes=include_placed,
        admin_sent_only=admin_sent_only,
        intake_method=intake_method,
        new_search_lead_only=new_search_lead_only,
        master_type=None if all_contacts else master_type,
        all_assigned_contacts=all_contacts,
        designation=designation,
        contact_person=contact_person,
        primary_mobile=primary_mobile,
        secondary_mobile=secondary_mobile,
        phone=phone,
        secondary_phone=secondary_phone,
        email=email,
        secondary_email=secondary_email,
        website=website,
        address=address,
        remarks=remarks,
        assigned_to_filter=assigned_to_filter,
    )
    return LeadTableResponse(**result)


@router.get("/table/column-values")
def get_lead_table_column_values(
    field: str = Query(...),
    score: str | None = None,
    country: str | None = None,
    industry: str | None = None,
    company_grading: str | None = None,
    product_interest: str | None = None,
    city: str | None = None,
    call_recommended: str | None = None,
    source: str | None = None,
    exclude_source: str | None = None,
    call_outcome: str | None = None,
    in_interested_clients: bool = False,
    market_role: str | None = None,
    q: str | None = None,
    assigned_to_user_id: int | None = None,
    my_assigned: bool = False,
    master: bool = False,
    intake_method: str | None = None,
    new_search_lead_only: bool = False,
    master_type: str | None = None,
    all_contacts: bool = False,
    designation: str | None = None,
    contact_person: str | None = None,
    primary_mobile: str | None = None,
    secondary_mobile: str | None = None,
    phone: str | None = None,
    secondary_phone: str | None = None,
    email: str | None = None,
    secondary_email: str | None = None,
    website: str | None = None,
    address: str | None = None,
    remarks: str | None = None,
    assigned_to_filter: str | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    assignee_id, unassigned_only, include_placed, pool_for_user_id, admin_sent_only = (
        _table_assignment_filters(
            user,
            assigned_to_user_id=assigned_to_user_id,
            my_assigned=my_assigned or all_contacts,
            call_outcome=call_outcome,
            source=source,
            exclude_source=exclude_source,
            master=master,
            in_interested_clients=in_interested_clients,
        )
    )
    result = leads_module.get_lead_table_column_values(
        db,
        field=field,
        score=score,
        country=country,
        industry=industry,
        company_grading=company_grading,
        product_interest=product_interest,
        city=city,
        call_recommended=call_recommended,
        source=source,
        exclude_source=exclude_source,
        call_outcome=call_outcome,
        in_interested_clients=in_interested_clients,
        market_role=market_role,
        q=q,
        assigned_to_user_id=assignee_id,
        unassigned_only=unassigned_only,
        pool_for_user_id=pool_for_user_id,
        include_placed_outcomes=include_placed,
        admin_sent_only=admin_sent_only,
        intake_method=intake_method,
        new_search_lead_only=new_search_lead_only,
        master_type=None if all_contacts else master_type,
        all_assigned_contacts=all_contacts,
        designation=designation,
        contact_person=contact_person,
        primary_mobile=primary_mobile,
        secondary_mobile=secondary_mobile,
        phone=phone,
        secondary_phone=secondary_phone,
        email=email,
        secondary_email=secondary_email,
        website=website,
        address=address,
        remarks=remarks,
        assigned_to_filter=assigned_to_filter,
    )
    return result


@router.get("/table/ids", response_model=LeadTableIdsResponse)
def list_leads_table_ids(
    score: str | None = None,
    country: str | None = None,
    industry: str | None = None,
    company_grading: str | None = None,
    product_interest: str | None = None,
    city: str | None = None,
    call_recommended: str | None = None,
    source: str | None = None,
    exclude_source: str | None = None,
    call_outcome: str | None = None,
    in_interested_clients: bool = False,
    market_role: str | None = None,
    q: str | None = None,
    sort_by: str = "company_name",
    sort_dir: str = "asc",
    assigned_to_user_id: int | None = None,
    my_assigned: bool = False,
    master: bool = False,
    intake_method: str | None = None,
    new_search_lead_only: bool = False,
    master_type: str | None = None,
    all_contacts: bool = False,
    designation: str | None = None,
    contact_person: str | None = None,
    primary_mobile: str | None = None,
    secondary_mobile: str | None = None,
    phone: str | None = None,
    secondary_phone: str | None = None,
    email: str | None = None,
    secondary_email: str | None = None,
    website: str | None = None,
    address: str | None = None,
    remarks: str | None = None,
    assigned_to_filter: str | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    assignee_id, unassigned_only, include_placed, pool_for_user_id, admin_sent_only = (
        _table_assignment_filters(
            user,
            assigned_to_user_id=assigned_to_user_id,
            my_assigned=my_assigned or all_contacts,
            call_outcome=call_outcome,
            source=source,
            exclude_source=exclude_source,
            master=master,
            in_interested_clients=in_interested_clients,
        )
    )
    result = leads_module.list_leads_table_ids(
        db,
        score=score,
        country=country,
        industry=industry,
        company_grading=company_grading,
        product_interest=product_interest,
        city=city,
        call_recommended=call_recommended,
        source=source,
        exclude_source=exclude_source,
        call_outcome=call_outcome,
        in_interested_clients=in_interested_clients,
        market_role=market_role,
        q=q,
        sort_by=sort_by,
        sort_dir=sort_dir,
        assigned_to_user_id=assignee_id,
        unassigned_only=unassigned_only,
        pool_for_user_id=pool_for_user_id,
        include_placed_outcomes=include_placed,
        admin_sent_only=admin_sent_only,
        intake_method=intake_method,
        new_search_lead_only=new_search_lead_only,
        master_type=None if all_contacts else master_type,
        all_assigned_contacts=all_contacts,
        designation=designation,
        contact_person=contact_person,
        primary_mobile=primary_mobile,
        secondary_mobile=secondary_mobile,
        phone=phone,
        secondary_phone=secondary_phone,
        email=email,
        secondary_email=secondary_email,
        website=website,
        address=address,
        remarks=remarks,
        assigned_to_filter=assigned_to_filter,
    )
    return LeadTableIdsResponse(**result)


@router.get("/table/section-counts", response_model=LeadTableSectionCountsResponse)
def get_leads_table_section_counts(
    master_type: str = "fmcg",
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    assigned_id = None if _is_admin(user) else user.id
    counts = leads_module.count_leads_table_sections(
        db,
        assigned_to_user_id=assigned_id,
        pool_for_user_id=None,
        master_type=master_type,
    )
    counts["all_contacts"] = leads_module.count_my_assigned_leads(db, user.id)
    counts["my_assigned"] = leads_module.count_my_assigned_leads_filtered(
        db, user.id, master_type=master_type
    )
    return LeadTableSectionCountsResponse(**counts)


@router.patch("/table/{lead_id}", response_model=LeadTableRowRead)
def update_lead_table_row(
    lead_id: int,
    payload: LeadTableRowUpdate,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import activity as activity_module

    _require_buyer_access(db, user, lead_id)
    data = payload.model_dump(exclude_unset=True)
    fill_missing_only = bool(data.pop("fill_missing_only", False))
    if "assigned_to_user_id" in data or "assigned_to" in data:
        if not _is_admin(user):
            # Non-admin row edits may still include the current assignee field —
            # only block when they try to change who the lead is sent to.
            buyer = buyers_module.get_buyer(db, lead_id)
            requested = data.get("assigned_to_user_id", buyer.assigned_to_user_id if buyer else None)
            current = buyer.assigned_to_user_id if buyer else None
            if requested != current:
                raise HTTPException(
                    403,
                    "Only an admin can assign leads to users. Ask an admin to send leads to you.",
                )
            data.pop("assigned_to_user_id", None)
            data.pop("assigned_to", None)
        else:
            data.pop("assigned_to", None)
    try:
        row = leads_module.update_lead_table_row(
            db,
            lead_id,
            data,
            remarks_by=user.username,
            by_user_id=user.id,
            fill_missing_only=fill_missing_only,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not row:
        raise HTTPException(404, "Lead not found")

    if data:
        company = row.get("company_name") or f"Lead #{lead_id}"
        fields = ", ".join(sorted(data.keys()))
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.TABLE_ROW_EDITED,
            title="Lead table edited",
            summary=f"Updated {company}: {fields}",
            entity_type="buyer",
            entity_id=lead_id,
            details={"fields": sorted(data.keys()), "company_name": company},
        )
    return LeadTableRowRead(**row)


@router.delete("/table/{lead_id}", status_code=204)
def delete_lead_table_row(
    lead_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    _require_buyer_access(db, user, lead_id)
    if not leads_module.delete_lead_table_row(db, lead_id):
        raise HTTPException(404, "Lead not found")


@router.post("/table/bulk-delete", response_model=LeadTableBulkDeleteResponse)
def bulk_delete_lead_table_rows(
    payload: LeadTableBulkDeleteRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    lead_ids = list(dict.fromkeys(payload.lead_ids or []))
    if not lead_ids:
        raise HTTPException(400, "Select at least one lead to delete")
    # Sales users may only delete leads assigned to them; admin can delete any.
    if not _is_admin(user):
        forbidden = [
            lead_id
            for lead_id in lead_ids
            if not leads_module.user_can_access_buyer(db, user=user, buyer_id=lead_id)
        ]
        if forbidden:
            raise HTTPException(
                403,
                "You can only delete leads assigned to your account",
            )
    result = leads_module.delete_lead_table_rows(db, lead_ids)
    return LeadTableBulkDeleteResponse(**result)


@router.post("/table/bulk-assign", response_model=LeadTableBulkAssignResponse)
def bulk_assign_lead_table_rows(
    payload: LeadTableBulkAssignRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_admin),
):
    if not payload.lead_ids:
        raise HTTPException(400, "Select at least one lead to assign")
    try:
        result = leads_module.bulk_assign_lead_table_rows(
            db,
            payload.lead_ids,
            assigned_to_user_id=payload.assigned_to_user_id,
            by_user_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return LeadTableBulkAssignResponse(**result)


@router.post("/table/set-target-pool", response_model=LeadTableSetTargetPoolResponse)
def set_target_pool_rows(
    payload: LeadTableSetTargetPoolRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_admin),
):
    """Admin: move leads into Hyperstore / Targeted Distributor / Targeted Client pools."""
    if not payload.lead_ids:
        raise HTTPException(400, "Select at least one lead")
    try:
        result = leads_module.set_target_pool(
            db,
            lead_ids=payload.lead_ids,
            source=payload.source,
            intake_method=payload.intake_method,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return LeadTableSetTargetPoolResponse(**result)


class LeadTableMoveToModuleRequest(BaseModel):
    lead_ids: list[int] = Field(..., min_length=1, max_length=5000)
    target_module: str
    # Optional sanity check from the UI — must match len(unique lead_ids).
    expected_count: int | None = None


class LeadTableMoveToModuleResponse(BaseModel):
    updated_count: int
    updated_ids: list[int] = Field(default_factory=list)
    requested_count: int = 0
    target_module: str
    target_label: str


@router.post("/table/move-to-module", response_model=LeadTableMoveToModuleResponse)
def move_leads_to_target_module(
    payload: LeadTableMoveToModuleRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Move only the provided lead_ids into a destination section/module.

    Never expands to the whole folder — if the client sends 721 IDs, at most 721 move.
    """
    if not payload.lead_ids:
        raise HTTPException(400, "Select at least one lead")
    unique = list(dict.fromkeys(int(x) for x in payload.lead_ids if int(x) > 0))
    if payload.expected_count is not None and payload.expected_count != len(unique):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Selection mismatch: UI expected {payload.expected_count} leads but "
                f"request had {len(unique)} unique IDs. Clear selection and try again."
            ),
        )
    try:
        result = leads_module.move_leads_to_module(
            db,
            lead_ids=unique,
            target_module=payload.target_module,
            by_user_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return LeadTableMoveToModuleResponse(**result)


class ScheduleMeetingRequest(BaseModel):
    meeting_at: datetime | None = None
    meeting_location: str | None = None  # venue address
    meeting_notes: str | None = None
    meeting_priority: int | None = None
    country: str | None = None  # country of stay (timezone source)
    city: str | None = None
    confirm: bool = True


@router.get("/table/{lead_id}/meeting-suggest")
def suggest_lead_meeting(
    lead_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Suggest date/location/notes from call closed captions + lead address."""
    try:
        return leads_module.suggest_meeting_details(db, lead_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.patch("/table/{lead_id}/meeting-schedule", response_model=LeadTableRowRead)
def schedule_lead_meeting(
    lead_id: int,
    payload: ScheduleMeetingRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Confirm meetup details for SCHEDULE MEETING → PA only when confirm=true."""
    try:
        row = leads_module.schedule_buyer_meeting(
            db,
            buyer_id=lead_id,
            meeting_at=payload.meeting_at,
            meeting_location=payload.meeting_location,
            meeting_notes=payload.meeting_notes,
            meeting_priority=payload.meeting_priority,
            country=payload.country,
            city=payload.city,
            confirm=payload.confirm,
            by_user_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not row:
        raise HTTPException(404, "Lead not found")
    return LeadTableRowRead(**row)


@router.post("/table/populate-target-pool", response_model=LeadTablePopulateTargetPoolResponse)
def populate_target_pool_rows(
    payload: LeadTablePopulateTargetPoolRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_admin),
):
    """Admin: intelligently fill a targeted pool from Old clients or New search leads."""
    try:
        result = leads_module.populate_target_pool_intelligent(
            db,
            pool=payload.pool,
            from_source=payload.from_source,
            limit=payload.limit,
            min_score=payload.min_score,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return LeadTablePopulateTargetPoolResponse(**result)


@router.post("/table/remove-from-target-pool", response_model=LeadTableRemoveFromTargetPoolResponse)
def remove_from_target_pool_rows(
    payload: LeadTableRemoveFromTargetPoolRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_admin),
):
    """Admin: move leads out of a targeted pool (does not delete the lead)."""
    if not payload.lead_ids:
        raise HTTPException(400, "Select at least one lead")
    result = leads_module.remove_from_target_pool(db, lead_ids=payload.lead_ids)
    return LeadTableRemoveFromTargetPoolResponse(**result)


@router.post("/table/remove-from-schedule-meeting", response_model=LeadTableRemoveFromTargetPoolResponse)
def remove_from_schedule_meeting_rows(
    payload: LeadTableRemoveFromTargetPoolRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Remove leads from SCHEDULE MEETING (does not delete the lead)."""
    if not payload.lead_ids:
        raise HTTPException(400, "Select at least one lead")
    result = leads_module.remove_from_schedule_meeting(db, lead_ids=payload.lead_ids)
    return LeadTableRemoveFromTargetPoolResponse(**result)


@router.post(
    "/table/promote-incomplete-archives",
    response_model=LeadTablePromoteIncompleteArchivesResponse,
)
def promote_incomplete_archives_rows(
    payload: LeadTablePromoteIncompleteArchivesRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_admin),
):
    """Manual promotion from Incomplete Data from Archives → Old clients."""
    if not payload.lead_ids:
        raise HTTPException(400, "Select at least one lead")
    from modules.incomplete_archives import promote_from_incomplete_archives

    try:
        result = promote_from_incomplete_archives(db, lead_ids=payload.lead_ids)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return LeadTablePromoteIncompleteArchivesResponse(**result)


@router.post(
    "/table/classify-target-pools",
    response_model=LeadTableClassifyTargetPoolsResponse,
)
def classify_target_pools_from_old_clients(
    payload: LeadTableClassifyTargetPoolsRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_admin),
):
    """Admin: scan Old clients and move keyword matches into Hyperstore / Distributor pools."""
    result = leads_module.classify_target_pools_from_old_clients(
        db,
        limit_per_pool=payload.limit_per_pool,
    )
    return LeadTableClassifyTargetPoolsResponse(**result)


@router.post(
    "/table/interested-clients-membership",
    response_model=LeadTableInterestedClientsMembershipResponse,
)
def set_interested_clients_membership(
    payload: LeadTableInterestedClientsMembershipRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Add or remove leads from the Interested Clients table."""
    if not payload.lead_ids:
        raise HTTPException(400, "Select at least one lead")
    for lead_id in payload.lead_ids:
        _require_buyer_access(db, user, lead_id)
    from modules import interested_follow_ups as follow_ups_module

    result = follow_ups_module.set_interested_clients_list_membership(
        db,
        buyer_ids=payload.lead_ids,
        in_list=payload.in_list,
        user_id=user.id,
        user_label=user.username or user.full_name,
    )
    return LeadTableInterestedClientsMembershipResponse(**result)


def _maintenance_assignee_scope(
    user: AppUser,
    *,
    assigned_to_user_id: int | None,
    master: bool,
) -> tuple[int | None, bool]:
    """Assignee scope for dedupe / sparse cleanup.

    Returns (assigned_to_user_id, unassigned_only).
    """
    if master:
        return None, False
    if assigned_to_user_id is not None:
        return assigned_to_user_id, False
    # Pool sections (Leads table / Old clients): only unassigned rows.
    return None, True


@router.post("/table/dedupe", response_model=LeadTableDedupeResponse)
def dedupe_leads_table(
    source: str | None = None,
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    master: bool = False,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    assignee_id, unassigned_only = _maintenance_assignee_scope(
        user,
        assigned_to_user_id=assigned_to_user_id,
        master=master,
    )
    result = leads_module.dedupe_leads_table(
        db,
        source=source,
        exclude_source=exclude_source,
        assigned_to_user_id=assignee_id,
        unassigned_only=unassigned_only,
    )
    return LeadTableDedupeResponse(**result)


@router.post("/table/remove-old-client-overlaps", response_model=RemoveOldClientOverlapsResponse)
def remove_old_client_overlaps(
    db: Session = Depends(get_db),
    _: AppUser = Depends(require_admin),
):
    """Delete Discover / Leads-table rows that match an Old client by name or domain.

    Old clients are kept. Only overlapping new-discovery leads are removed.
    """
    result = leads_module.remove_leads_overlapping_old_clients(db)
    return RemoveOldClientOverlapsResponse(**result)


@router.post("/table/unassign-imports")
def unassign_spreadsheet_imports(
    db: Session = Depends(get_db),
    _: AppUser = Depends(require_admin),
):
    """Admin repair: move auto-imported CSV/old_clients leads out of 'Leads Sent To'."""
    return leads_module.unassign_spreadsheet_imports(db)


@router.post("/table/cleanup-sparse", response_model=LeadTableCleanupResponse)
def cleanup_sparse_csv_leads(
    source: str | None = None,
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    master: bool = False,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    assignee_id, unassigned_only = _maintenance_assignee_scope(
        user,
        assigned_to_user_id=assigned_to_user_id,
        master=master,
    )
    result = leads_module.cleanup_sparse_csv_leads(
        db,
        source=source,
        exclude_source=exclude_source,
        assigned_to_user_id=assignee_id,
        unassigned_only=unassigned_only,
    )
    return LeadTableCleanupResponse(**result)


@router.post("/table/repair-location-names", response_model=LeadTableNameRepairResponse)
def repair_location_company_names(
    source: str | None = None,
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    master: bool = False,
    dry_run: bool = False,
    limit: int | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Move location-as-company-name into city/country/address; recover real name."""
    from modules.buyer_name_repair import repair_location_company_names as repair_fn

    assignee_id, unassigned_only = _maintenance_assignee_scope(
        user,
        assigned_to_user_id=assigned_to_user_id,
        master=master,
    )
    result = repair_fn(
        db,
        source=source,
        exclude_source=exclude_source,
        assigned_to_user_id=assignee_id,
        unassigned_only=unassigned_only,
        dry_run=dry_run,
        limit=limit,
        sleep_s=0.05 if not dry_run else 0.0,
    )
    return LeadTableNameRepairResponse(**result)


@router.post("/table/clean-company-fields", response_model=LeadTableCompanyCleanResponse)
def clean_company_fields(
    source: str | None = None,
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    master: bool = False,
    dry_run: bool = False,
    limit: int | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Usman pass-1: move address/email/placeholder values out of Company Name."""
    from modules.old_clients_clean import clean_old_clients_company_fields

    assignee_id, unassigned_only = _maintenance_assignee_scope(
        user,
        assigned_to_user_id=assigned_to_user_id,
        master=master,
    )
    # Default scope: Old clients (Usman's cleaning reference).
    effective_source = source if source is not None else "old_clients"
    result = clean_old_clients_company_fields(
        db,
        source=effective_source,
        exclude_source=exclude_source,
        assigned_to_user_id=assignee_id,
        unassigned_only=unassigned_only,
        dry_run=dry_run,
        limit=limit,
    )
    return LeadTableCompanyCleanResponse(**result)


@router.post("/table/post-import-clean", response_model=PostImportCleanResponse)
def post_import_clean(
    source: str | None = None,
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    master: bool = False,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """After Old clients upload: fix emails, company fields, names, junk, dedupe."""
    from modules.post_import_old_clients import run_post_import_clean

    assignee_id, unassigned_only = _maintenance_assignee_scope(
        user,
        assigned_to_user_id=assigned_to_user_id,
        master=master,
    )
    effective_source = source if source is not None else "old_clients"
    result = run_post_import_clean(
        db,
        source=effective_source,
        exclude_source=exclude_source,
        assigned_to_user_id=assignee_id,
        unassigned_only=unassigned_only,
    )
    return PostImportCleanResponse(**result)


@router.get("/discover/regions", response_model=DiscoveryRegionsResponse)
def get_discovery_regions(_: AppUser = Depends(get_current_user)):
    data = list_discovery_regions()
    return DiscoveryRegionsResponse(**data)


@router.post("/discover", response_model=DiscoverLeadsResponse)
def discover_similar_leads(
    payload: DiscoverLeadsRequest,
    db: Session = Depends(get_db),
    _: AppUser = Depends(get_current_user),
):
    result = discover_leads(
        db,
        seed_lead_id=payload.seed_lead_id,
        region_codes=payload.region_codes,
        country=payload.country,
        industry=payload.industry,
        industries=payload.industries,
        categories=payload.categories,
        limit=payload.limit,
        use_web_search=payload.use_web_search,
        use_website_links=payload.use_website_links,
        skip_enrichment=payload.skip_enrichment,
    )
    return DiscoverLeadsResponse(
        candidates=[DiscoveryCandidateRead(**c.to_dict()) for c in result.candidates],
        sources_used=result.sources_used,
        messages=result.messages,
        search_query=result.search_query,
    )


@router.post("/discover/enrich", response_model=DiscoveryCandidateRead)
def enrich_discovered_lead(
    payload: DiscoveryCandidateRead,
    db: Session = Depends(get_db),
    _: AppUser = Depends(get_current_user),
):
    candidate = discovery_candidate_from_dict(payload.model_dump())
    enrich_discovery_candidate(candidate)
    existing_names, existing_domains = _existing_buyer_keys(
        db,
        **_import_scope_for_source(None),
    )
    _mark_existing([candidate], existing_names, existing_domains)
    return DiscoveryCandidateRead(**candidate.to_dict())


@router.post("/discover/csv", response_model=DiscoverLeadsResponse)
async def discover_leads_from_csv(
    file: UploadFile = File(...),
    default_country: str | None = None,
    for_leads_table: bool = False,
    import_source: str | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "The uploaded file is empty.")
    ext = Path((file.filename or "").strip()).suffix.lower()
    if ext and ext not in SUPPORTED_UPLOAD_EXTENSIONS:
        supported = ", ".join(sorted(SUPPORTED_UPLOAD_EXTENSIONS))
        raise HTTPException(400, f"Upload a supported file ({supported})")
    try:
        content, convert_messages = convert_upload_to_csv(file.filename, raw)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    # Sales preview: only mark already_exists against that user's own table.
    assignee = None if _is_admin(user) else user.id
    result = discover_from_csv(
        db,
        content,
        default_country=default_country,
        for_leads_table=for_leads_table,
        import_source=import_source,
        assigned_to_user_id=assignee,
    )
    result.messages = convert_messages + result.messages
    if not result.candidates:
        detail = (
            "; ".join(result.messages)
            if result.messages
            else "No importable rows found in this file."
        )
        raise HTTPException(400, detail)
    return DiscoverLeadsResponse(
        candidates=[DiscoveryCandidateRead(**c.to_dict()) for c in result.candidates],
        sources_used=result.sources_used,
        messages=result.messages,
        search_query=result.search_query,
        import_parser=OLD_CLIENTS_IMPORT_PARSER,
    )


@router.post("/discover/import", response_model=DiscoverImportResponse)
def import_discovered_leads(
    payload: DiscoverImportRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import activity as activity_module

    # Admin imports land in the shared pool (unassigned). Sales-user imports
    # are auto-assigned to that user so they stay private to their account.
    assignee = None if _is_admin(user) else user.id
    result = import_candidates(
        db,
        [c.model_dump() for c in payload.candidates],
        auto_onboard=payload.auto_onboard,
        replace_duplicates=payload.replace_duplicates,
        skip_enrichment=payload.skip_enrichment,
        assigned_to_user_id=assignee,
    )
    created_count = int(result.get("created_count") or 0)
    if created_count > 0:
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.LEADS_IMPORTED,
            title="Leads imported",
            summary=f"Imported {created_count} lead{'s' if created_count != 1 else ''} into the table",
            quantity=created_count,
            entity_type="buyer",
            entity_id=None,
            details={
                "created_count": created_count,
                "skipped_count": result.get("skipped_count", 0),
                "replaced_count": result.get("replaced_count", 0),
            },
        )
    return DiscoverImportResponse(
        created_count=result["created_count"],
        skipped_count=result["skipped_count"],
        replaced_count=result.get("replaced_count", 0),
        created=result["created"],
        skipped=result["skipped"],
        replaced=result.get("replaced", []),
        onboard_results=result["onboard_results"],
    )


@router.post("/discover/import-async", response_model=ImportJobStartResponse)
def import_discovered_leads_async(
    payload: DiscoverImportRequest,
    user: AppUser = Depends(get_current_user),
):
    """Start a background import job and return immediately.

    Large spreadsheets (1000-2000+ rows) exceed request timeouts when imported
    synchronously; the frontend polls GET /leads/import-jobs/{job_id} instead
    to drive a live progress bar.
    """
    from modules import import_jobs

    # Admin imports stay unassigned; sales-user imports are assigned to them.
    assignee = None if _is_admin(user) else user.id
    try:
        job_id = import_jobs.start_import_job(
            [c.model_dump() for c in payload.candidates],
            auto_onboard=payload.auto_onboard,
            replace_duplicates=payload.replace_duplicates,
            skip_enrichment=payload.skip_enrichment,
            assigned_to_user_id=assignee,
            user_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return ImportJobStartResponse(job_id=job_id, total=len(payload.candidates))


@router.get("/import-jobs/{job_id}", response_model=ImportJobStatusResponse)
def get_import_job_status(
    job_id: str,
    _: AppUser = Depends(get_current_user),
):
    from modules import import_jobs

    job = import_jobs.get_job(job_id)
    if job is None:
        raise HTTPException(404, "Import job not found (it may have expired after a server restart)")
    return ImportJobStatusResponse(**job)


@router.get("/table/import-rollback")
def get_import_rollback_status(
    source: str = Query(..., min_length=1),
    force: bool = Query(False),
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_admin),
):
    """Admin only — whether Undo last import is available for this list (1 hour window)."""
    _ = user
    from modules.import_rollback import get_rollback_status

    return get_rollback_status(db, source, allow_expired=bool(force))


class ImportRollbackRequest(BaseModel):
    source: str
    # Admin emergency: allow undo past the 1-hour window (still only last import).
    force: bool = False


@router.post("/table/import-rollback")
def post_import_rollback(
    payload: ImportRollbackRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_admin),
):
    """Admin only — undo the last spreadsheet import into this list (within 1 hour)."""
    from modules.import_rollback import rollback_last_import

    try:
        return rollback_last_import(
            db,
            source=payload.source,
            actor_user_id=user.id,
            allow_expired=bool(payload.force),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/{lead_id}/cross-sell")
def cross_sell_recommendations(
    lead_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules.commerce import get_commerce

    _require_buyer_access(db, user, lead_id)
    if not buyers_module.get_buyer(db, lead_id):
        raise HTTPException(404, "Lead not found")
    return get_commerce().recommend_cross_sell_from_catalog(db, lead_id)


@router.get("/{lead_id}", response_model=BuyerRead)
def get_lead(
    lead_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    _require_buyer_access(db, user, lead_id)
    buyer = buyers_module.get_buyer(db, lead_id)
    if not buyer:
        raise HTTPException(404, "Lead not found")
    return buyer


@router.post("/{lead_id}/research", response_model=BuyerProfileRead)
def research_lead(
    lead_id: int,
    force: bool = False,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    _require_buyer_access(db, user, lead_id)
    if not buyers_module.get_buyer(db, lead_id):
        raise HTTPException(404, "Lead not found")
    try:
        profile = leads_module.research_buyer(db, lead_id, force_refresh=force)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    log_action(
        db,
        entity_type="buyer",
        entity_id=lead_id,
        action="research_completed",
        details={"researched_at": profile.researched_at.isoformat() if profile.researched_at else None},
    )
    return BuyerProfileRead(**leads_module.profile_to_read_dict(profile))


@router.get("/{lead_id}/profile", response_model=BuyerProfileRead)
def get_lead_profile(
    lead_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    _require_buyer_access(db, user, lead_id)
    if not buyers_module.get_buyer(db, lead_id):
        raise HTTPException(404, "Lead not found")
    try:
        profile = leads_module.get_saved_buyer_profile(db, lead_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    if not profile:
        raise HTTPException(404, "No research profile on record for this lead")
    return BuyerProfileRead(**leads_module.profile_to_read_dict(profile))


@router.get("/{lead_id}/score", response_model=LeadScoreRead)
def get_latest_lead_score(
    lead_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    _require_buyer_access(db, user, lead_id)
    if not buyers_module.get_buyer(db, lead_id):
        raise HTTPException(404, "Lead not found")
    score = leads_module.get_latest_score(db, lead_id)
    if not score:
        raise HTTPException(404, "No score on record for this lead")
    return score


@router.post("/{lead_id}/score", response_model=LeadScoreRead)
def score_lead(
    lead_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    _require_buyer_access(db, user, lead_id)
    if not buyers_module.get_buyer(db, lead_id):
        raise HTTPException(404, "Lead not found")
    try:
        return leads_module.score_buyer(db, lead_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/{lead_id}/onboard")
def onboard_lead(
    lead_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    _require_buyer_access(db, user, lead_id)
    if not buyers_module.get_buyer(db, lead_id):
        raise HTTPException(404, "Lead not found")
    try:
        result = leads_module.onboard_buyer(db, lead_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"Research failed: {exc}") from exc
    return {
        "buyer_id": result["buyer_id"],
        "score": result["score"],
        "reasoning": result["reasoning"],
        "next_actions": result["next_actions"],
        "enrichment": result.get("enrichment"),
    }


@router.post("/enrichment/compare")
async def compare_enrichment_file_endpoint(
    file: UploadFile = File(...),
    user_id: str | None = Query(default=None),
    table_source: str = Query(default="master_table"),
    master_type: str = Query(default="fmcg"),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import enrichment_comparison as comparison_module
    content = await file.read()
    parsed_user_id = None
    if user_id is not None:
        u_str = str(user_id).strip().lower()
        if u_str and u_str not in ("none", "null", "undefined", "nan", "") and u_str.isdigit():
            parsed_user_id = int(u_str)
    try:
        return comparison_module.generate_enrichment_comparison_report(
            db,
            file_content=content,
            filename=file.filename or "enrichment.xlsx",
            user_id=parsed_user_id,
            table_source=table_source,
            master_type=master_type,
        )
    except Exception as exc:
        raise HTTPException(400, f"Could not analyze file: {exc}") from exc


@router.post("/enrichment/safe-merge")
async def safe_merge_enrichment_file_endpoint(
    file: UploadFile = File(...),
    user_id: str | None = Query(default=None),
    table_source: str = Query(default="master_table"),
    master_type: str = Query(default="fmcg"),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    import traceback
    import logging
    logger = logging.getLogger(__name__)
    try:
        from modules import enrichment_comparison as comparison_module
        content = await file.read()
        parsed_user_id = None
        if user_id is not None:
            u_str = str(user_id).strip().lower()
            if u_str and u_str not in ("none", "null", "undefined", "nan", "") and u_str.isdigit():
                parsed_user_id = int(u_str)

        return comparison_module.execute_safe_fill_merge(
            db,
            file_content=content,
            filename=file.filename or "enrichment.xlsx",
            user_id=parsed_user_id,
            table_source=table_source,
            master_type=master_type,
        )
    except Exception as exc:
        tb = traceback.format_exc()
        logger.error(f"Error in safe merge endpoint: {exc}\n{tb}")
        raise HTTPException(500, f"Could not execute safe merge: {exc} | Trace: {tb}") from exc


@router.get("/missing-data-report")
def get_missing_data_report_endpoint(
    section: str = Query(default="master"),
    column_key: str = Query(default="contact_name"),
    user_id: str | None = Query(default=None),
    master_type: str = Query(default="fmcg"),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import enrichment_comparison as comparison_module
    parsed_user_id = None
    if user_id is not None:
        u_str = str(user_id).strip().lower()
        if u_str and u_str not in ("none", "null", "undefined", "nan", "") and u_str.isdigit():
            parsed_user_id = int(u_str)
    try:
        return comparison_module.generate_missing_data_report(
            db,
            section=section,
            column_key=column_key,
            user_id=parsed_user_id,
            master_type=master_type,
            viewer=user,
        )
    except Exception as exc:
        raise HTTPException(400, f"Could not generate missing data report: {exc}") from exc

