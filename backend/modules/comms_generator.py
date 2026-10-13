from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from db.models import (
    Buyer,
    Channel,
    Contact,
    Direction,
    HandledBy,
    Interaction,
    InteractionStatus,
)
from integrations.mail_client import mail_client
from integrations.whatsapp_client import whatsapp_client
from modules.email_attachments import (
    copy_attachments,
    merge_attachments,
    public_attachments,
    resolve_attachment_list,
    whatsapp_send_error,
)

WHATSAPP_SESSION_WINDOW_HOURS = 24

# Last Meta Cloud phone_number_id seen on inbound webhooks (this process).
_LAST_WEBHOOK_PHONE_NUMBER_ID: str | None = None
_LAST_WEBHOOK_DISPLAY_NUMBER: str | None = None


def note_whatsapp_webhook_metadata(
    *,
    phone_number_id: str | None,
    display_phone_number: str | None = None,
) -> None:
    """Remember which business number Meta delivered the last inbound webhook for."""
    global _LAST_WEBHOOK_PHONE_NUMBER_ID, _LAST_WEBHOOK_DISPLAY_NUMBER
    pid = (phone_number_id or "").strip()
    if pid:
        _LAST_WEBHOOK_PHONE_NUMBER_ID = pid
    disp = (display_phone_number or "").strip()
    if disp:
        _LAST_WEBHOOK_DISPLAY_NUMBER = disp


def whatsapp_phone_number_id_mismatch() -> str | None:
    """Warn when Railway WHATSAPP_PHONE_NUMBER_ID ≠ the number Meta is webhooking."""
    from config import settings

    configured = (settings.whatsapp_phone_number_id or "").strip()
    inbound = (_LAST_WEBHOOK_PHONE_NUMBER_ID or "").strip()
    if not configured or not inbound:
        return None
    if configured == inbound:
        return None
    display = _LAST_WEBHOOK_DISPLAY_NUMBER or "unknown"
    return (
        f"Meta webhooks arrive for phone_number_id={inbound} ({display}) but "
        f"WHATSAPP_PHONE_NUMBER_ID on Railway is {configured}. "
        "Replies then fail with Re-engagement / 24h window errors. "
        "Set WHATSAPP_PHONE_NUMBER_ID to the inbound id and redeploy."
    )


def contact_within_whatsapp_session_window(
    db: Session,
    contact: Contact | None,
) -> bool:
    """True if Meta customer-care window should still be open for free-text replies."""
    if not contact:
        return False
    now = datetime.now(timezone.utc)
    expires = contact.whatsapp_window_expires_at
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires and expires > now:
        return True
    # Fallback: any recent Cloud inbound (covers missed expires_at writes).
    cutoff = now - timedelta(hours=WHATSAPP_SESSION_WINDOW_HOURS)
    recent = (
        db.query(Interaction.id)
        .filter(
            Interaction.contact_id == contact.id,
            Interaction.channel == Channel.whatsapp,
            Interaction.direction == Direction.inbound,
            Interaction.created_at >= cutoff,
            Interaction.personal_whatsapp_user_id.is_(None),
        )
        .limit(1)
        .first()
    )
    return recent is not None


def _whatsapp_unread_count(db: Session, contact_id: int) -> int:
    """Inbound messages since the last outbound — awaiting a reply."""
    last_outbound = (
        db.query(Interaction)
        .filter(
            Interaction.contact_id == contact_id,
            Interaction.channel == Channel.whatsapp,
            Interaction.direction == Direction.outbound,
        )
        .order_by(Interaction.created_at.desc())
        .first()
    )
    query = db.query(Interaction).filter(
        Interaction.contact_id == contact_id,
        Interaction.channel == Channel.whatsapp,
        Interaction.direction == Direction.inbound,
    )
    if last_outbound and last_outbound.created_at:
        query = query.filter(Interaction.created_at > last_outbound.created_at)
    return int(query.count())


def _bulk_results_detail(created: list[dict], skipped: list[dict], limit: int = 1000) -> list[dict]:
    """Per-contact outcome of a bulk WhatsApp send (stored on the campaign summary event)."""
    rows: list[dict] = []
    for item in created:
        sent = bool(item.get("sent"))
        rows.append(
            {
                "buyer_id": item.get("buyer_id"),
                "company_name": item.get("company_name"),
                "contact_name": item.get("contact_name"),
                "phone": item.get("phone"),
                "status": "sent" if sent else "failed",
                "message": "" if sent else str(item.get("send_message") or "Not delivered")[:300],
            }
        )
    for sk in skipped:
        rows.append(
            {
                "buyer_id": sk.get("buyer_id"),
                "company_name": sk.get("company_name"),
                "contact_name": None,
                "phone": None,
                "status": "skipped",
                "message": str(sk.get("reason") or "Skipped")[:300],
            }
        )
    return rows[:limit]


class CommsGenerator:
    """Template-based draft messages. LLM generation plugs in later."""

    def generate_email_draft(
        self,
        db: Session,
        *,
        contact_id: int,
        goal: str,
        product_name: str | None = None,
        attachments: list[dict] | None = None,
    ) -> Interaction:
        contact = db.get(Contact, contact_id)
        if not contact:
            raise ValueError("Contact not found")
        buyer = db.get(Buyer, contact.buyer_id)

        company = buyer.company_name if buyer else "your company"
        subject = f"Kafi Commodities — {goal}"

        # Template fallback
        fallback = (
            f"Dear {contact.full_name},\n\n"
            f"I hope this message finds you well. Following up regarding {goal.lower()} "
            f"for {company}."
        )
        if product_name:
            fallback += f"\n\nWe would be pleased to discuss our {product_name} offering."
        fallback += (
            "\n\nPlease let us know a convenient time to connect.\n\n"
            "Best regards,\nKafi Commodities Sales Team"
        )

        from modules.llm_client import llm_client
        buyer_context = (
            f"Buyer: {company}, Country: {getattr(buyer, 'country', 'unknown')}, "
            f"Industry: {getattr(buyer, 'industry', 'unknown')}"
        )
        body = llm_client.draft_email(
            buyer_country=getattr(buyer, "country", "") or "",
            target_language=contact.preferred_language or "en",
            buyer_context=buyer_context,
            goal=goal,
            product_specs=product_name or "Kafi ESSENCE range",
            fallback_body=fallback,
        )

        draft = Interaction(
            contact_id=contact_id,
            channel=Channel.email,
            direction=Direction.outbound,
            subject=subject,
            content=body,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.agent,
            status=InteractionStatus.draft,
            attachments=copy_attachments(resolve_attachment_list(attachments)),
        )
        db.add(draft)
        db.commit()
        db.refresh(draft)
        return draft

    def generate_product_interest_email(
        self,
        db: Session,
        *,
        contact_id: int,
        products: list[dict[str, str]],
        attachments: list[dict] | None = None,
    ) -> Interaction:
        contact = db.get(Contact, contact_id)
        if not contact:
            raise ValueError("Contact not found")
        if not contact.email:
            raise ValueError("Contact has no email address")

        buyer = db.get(Buyer, contact.buyer_id)
        company = buyer.company_name if buyer else "your company"

        lines = []
        for item in products:
            name = item.get("name", "")
            category = item.get("category", "")
            if category:
                cat_label = category.replace("_", " ").title()
                lines.append(f"• {name} ({cat_label})")
            else:
                lines.append(f"• {name}")

        product_block = "\n".join(lines)
        subject = f"Kafi Commodities — ESSENCE products for {company}"
        fallback_body = (
            f"Dear {contact.full_name},\n\n"
            f"I hope this message finds you well. Based on what we know about "
            f"{company}, we believe the following products from our Kafi ESSENCE "
            f"range may be a good fit for your business:\n\n"
            f"{product_block}\n\n"
            f"We would be pleased to share specifications, packaging options, and "
            f"pricing tailored to your market. Let us know which lines you would "
            f"like to explore further.\n\n"
            f"Best regards,\nKafi Commodities Sales Team"
        )

        from modules.llm_client import llm_client
        buyer_context = (
            f"Buyer: {company}, Country: {getattr(buyer, 'country', 'unknown')}, "
            f"Industry: {getattr(buyer, 'industry', 'unknown')}"
        )
        product_specs = product_block
        body = llm_client.draft_email(
            buyer_country=getattr(buyer, "country", "") or "",
            target_language=contact.preferred_language or "en",
            buyer_context=buyer_context,
            goal="introduce Kafi ESSENCE product range",
            product_specs=product_specs,
            fallback_body=fallback_body,
        )

        draft = Interaction(
            contact_id=contact_id,
            channel=Channel.email,
            direction=Direction.outbound,
            subject=subject,
            content=body,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.agent,
            status=InteractionStatus.draft,
            attachments=copy_attachments(resolve_attachment_list(attachments)),
        )
        db.add(draft)
        db.commit()
        db.refresh(draft)
        return draft

    def generate_quotation_email(
        self,
        db: Session,
        *,
        contact_id: int,
        buyer_name: str,
        product_name: str,
        quantity: float,
        unit_price: float,
        unit_label: str,
        line_total: float,
        incoterms: str | None,
        validity_date,
        lines: list[dict] | None = None,
    ) -> Interaction:
        contact = db.get(Contact, contact_id)
        if not contact:
            raise ValueError("Contact not found")
        if not contact.email:
            raise ValueError("Contact has no email address")

        if lines and len(lines) > 1:
            subject = f"Kafi Commodities — Quotation for {buyer_name}"
            product_lines = "\n".join(
                f"- {row['product_name']}: {row['quantity']} @ {row['unit_price']} "
                f"({row.get('price_unit') or unit_label}) = USD {row['line_total']:,.2f}"
                for row in lines
            )
            body = (
                f"Dear {contact.full_name},\n\n"
                f"Please find below our quotation for {buyer_name}.\n\n"
                f"{product_lines}\n\n"
                f"Grand total: USD {line_total:,.2f}\n"
                f"Incoterms: {incoterms or 'FOB'}\n"
                f"Validity: {validity_date}\n\n"
                f"We can share specification sheets and arrange samples on request.\n\n"
                f"Best regards,\nKafi Commodities Export Team"
            )
        else:
            subject = f"Kafi Commodities — Quotation for {product_name}"
            body = (
                f"Dear {contact.full_name},\n\n"
                f"Please find below our quotation for {product_name} "
                f"for {buyer_name}.\n\n"
                f"Product: {product_name}\n"
                f"Quantity: {quantity}\n"
                f"Unit price: {unit_price} ({unit_label})\n"
                f"Incoterms: {incoterms or 'FOB'}\n"
                f"Line total: USD {line_total:,.2f}\n"
                f"Validity: {validity_date}\n\n"
                f"We can share the full specification sheet and arrange samples on request.\n\n"
                f"Best regards,\nKafi Commodities Export Team"
            )
        draft = Interaction(
            contact_id=contact_id,
            channel=Channel.email,
            direction=Direction.outbound,
            subject=subject,
            content=body,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.agent,
            status=InteractionStatus.draft,
        )
        db.add(draft)
        db.commit()
        db.refresh(draft)
        return draft

    def generate_whatsapp_reply(
        self,
        db: Session,
        *,
        contact_id: int,
        inbound_message: str,
    ) -> Interaction:
        contact = db.get(Contact, contact_id)
        if not contact:
            raise ValueError("Contact not found")

        reply = (
            f"Thank you for your message. We have received your inquiry and "
            f"will respond with details shortly.\n\n(Original: {inbound_message[:200]})"
        )
        draft = Interaction(
            contact_id=contact_id,
            channel=Channel.whatsapp,
            direction=Direction.outbound,
            content=reply,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.agent,
            status=InteractionStatus.draft,
        )
        db.add(draft)
        db.commit()
        db.refresh(draft)
        return draft

    def _find_whatsapp_contact(self, db: Session, wa_id: str) -> Contact | None:
        """Match by Meta wa_id, E.164 phone, or bare digits."""
        from integrations.voice_client import normalize_e164

        raw = (wa_id or "").strip()
        if not raw:
            return None
        digits = "".join(ch for ch in raw if ch.isdigit())
        normalized = normalize_e164(raw) or normalize_e164(digits)

        candidates = [raw, digits]
        if normalized:
            candidates.append(normalized)
            candidates.append(normalized.lstrip("+"))
        # Deduplicate while preserving order
        seen: set[str] = set()
        keys: list[str] = []
        for key in candidates:
            if key and key not in seen:
                seen.add(key)
                keys.append(key)

        contact = (
            db.query(Contact)
            .filter(Contact.wa_id.in_(keys))
            .order_by(Contact.id.asc())
            .first()
        )
        if contact:
            return contact

        phone_keys = [k for k in keys if k.startswith("+") or len(k) >= 10]
        if phone_keys:
            contact = (
                db.query(Contact)
                .filter(Contact.phone.in_(phone_keys))
                .order_by(Contact.id.asc())
                .first()
            )
            if contact:
                return contact

        # Last-resort: match phone/wa_id by trailing digits (country-code drift).
        if len(digits) >= 10:
            tail = digits[-10:]
            for row in (
                db.query(Contact)
                .filter((Contact.phone.isnot(None)) | (Contact.wa_id.isnot(None)))
                .order_by(Contact.id.desc())
                .limit(500)
                .all()
            ):
                for value in (row.phone, row.wa_id):
                    if value and "".join(ch for ch in value if ch.isdigit()).endswith(tail):
                        return row
        return None

    def _ensure_whatsapp_contact(
        self,
        db: Session,
        *,
        wa_id: str,
        profile_name: str | None = None,
    ) -> Contact:
        """Find or auto-create a buyer+contact so inbound WhatsApp is never dropped."""
        from integrations.voice_client import normalize_e164

        contact = self._find_whatsapp_contact(db, wa_id)
        if contact:
            return contact

        digits = "".join(ch for ch in (wa_id or "") if ch.isdigit())
        phone = normalize_e164(wa_id) or normalize_e164(digits) or (f"+{digits}" if digits else wa_id)
        display = (profile_name or "").strip() or phone or wa_id
        buyer = Buyer(
            company_name=display,
            source="whatsapp_inbound",
            remarks="Auto-created from inbound WhatsApp message",
        )
        db.add(buyer)
        db.flush()
        contact = Contact(
            buyer_id=buyer.id,
            full_name=display,
            phone=phone,
            wa_id=digits or wa_id,
            whatsapp_opt_in=True,
            data_source="whatsapp_inbound",
        )
        db.add(contact)
        db.flush()
        return contact

    def record_inbound_whatsapp_message(
        self,
        db: Session,
        *,
        wa_id: str,
        message_text: str,
        provider_message_id: str | None = None,
        profile_name: str | None = None,
        create_reply_draft: bool = True,
        personal_whatsapp_user_id: int | None = None,
        meta_timestamp: int | str | None = None,
    ) -> Interaction | None:
        """Webhook entrypoint — logs inbound WhatsApp, opens the 24h window.

        Unknown senders are auto-created as individual leads so messages always
        appear in WhatsApp inbox.

        ``meta_timestamp`` is Meta's ``messages[].timestamp`` (unix seconds). Using
        webhook arrival time alone can show a false open window when Meta retries
        old deliveries — then free-text replies fail with (#131047) Re-engagement.
        """
        if provider_message_id:
            existing = (
                db.query(Interaction)
                .filter(Interaction.provider_message_id == provider_message_id)
                .first()
            )
            if existing:
                return existing

        contact = self._ensure_whatsapp_contact(
            db, wa_id=wa_id, profile_name=profile_name
        )
        digits = "".join(ch for ch in (wa_id or "") if ch.isdigit())
        # Always refresh Meta's canonical WhatsApp id from the inbound webhook.
        # Keeping a stale wa_id (e.g. from an old manual dial) makes Graph accept
        # the send then fail delivery with (#131047) Re-engagement message.
        if digits:
            contact.wa_id = digits
        elif wa_id:
            contact.wa_id = str(wa_id).strip()
        if not contact.phone:
            from integrations.voice_client import normalize_e164

            contact.phone = normalize_e164(wa_id) or normalize_e164(digits)
        if profile_name and (
            not contact.full_name
            or contact.full_name.startswith("+")
            or contact.data_source == "whatsapp_inbound"
        ):
            contact.full_name = profile_name.strip()
            buyer = db.get(Buyer, contact.buyer_id)
            if buyer and buyer.source == "whatsapp_inbound":
                buyer.company_name = profile_name.strip()

        now = datetime.now(timezone.utc)
        msg_at = now
        if meta_timestamp is not None and str(meta_timestamp).strip():
            try:
                ts = int(str(meta_timestamp).strip())
                # Meta sends seconds; ignore absurd values.
                if 1_000_000_000 <= ts <= 2_000_000_000:
                    msg_at = datetime.fromtimestamp(ts, tz=timezone.utc)
            except (TypeError, ValueError, OSError, OverflowError):
                msg_at = now

        contact.whatsapp_window_expires_at = msg_at + timedelta(
            hours=WHATSAPP_SESSION_WINDOW_HOURS
        )
        # Tag Cloud inbound so Meta Verified replies always match the Cloud inbox
        # filter (even if Meta's message id format changes). Baileys sets personal_user.
        cloud_inbound = personal_whatsapp_user_id is None
        inbound = Interaction(
            contact_id=contact.id,
            channel=Channel.whatsapp,
            direction=Direction.inbound,
            content=message_text,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.human,
            status=InteractionStatus.sent,
            provider_message_id=provider_message_id,
            personal_whatsapp_user_id=personal_whatsapp_user_id,
            wa_status="received" if cloud_inbound else None,
            created_at=msg_at,
        )
        db.add(inbound)
        db.commit()
        db.refresh(inbound)

        if create_reply_draft:
            self.generate_whatsapp_reply(
                db, contact_id=contact.id, inbound_message=message_text
            )
        return inbound

    def create_manual_whatsapp_draft(
        self,
        db: Session,
        *,
        contact_id: int,
        content: str,
    ) -> Interaction:
        contact = db.get(Contact, contact_id)
        if not contact:
            raise ValueError("Contact not found")
        if not contact.phone and not contact.wa_id:
            raise ValueError("Contact has no phone number on file")

        draft = Interaction(
            contact_id=contact_id,
            channel=Channel.whatsapp,
            direction=Direction.outbound,
            content=content,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.human,
            status=InteractionStatus.draft,
        )
        db.add(draft)
        db.commit()
        db.refresh(draft)
        return draft

    def _whatsapp_thread_filter(self, *, personal_user_id: int | None = None):
        """Cloud API threads vs personal Baileys QR threads (per Sales Agent user)."""
        base = (Interaction.channel == Channel.whatsapp) & (Interaction.contact_id.isnot(None))
        if personal_user_id is not None:
            return base & (Interaction.personal_whatsapp_user_id == int(personal_user_id))
        # Cloud / Meta Verified inbox only.
        # Do NOT use personal_whatsapp_user_id IS NULL — that full-scan hangs Railway.
        # Include: template sends, Meta wamid/meta_ ids, delivery wa_status, and any
        # inbound non-baileys message (customer replies to the Meta number).
        not_baileys = (Interaction.provider_message_id.is_(None)) | (
            ~Interaction.provider_message_id.like("baileys%")
        )
        cloud_signal = (
            (Interaction.template_name.isnot(None))
            | (Interaction.provider_message_id.like("wamid.%"))
            | (Interaction.provider_message_id.like("meta_%"))
            | (Interaction.wa_status.isnot(None))
            | (
                (Interaction.direction == Direction.inbound)
                & (Interaction.provider_message_id.isnot(None))
                & (~Interaction.provider_message_id.like("baileys%"))
            )
        )
        return base & cloud_signal & not_baileys

    def list_whatsapp_conversations(
        self,
        db: Session,
        *,
        assigned_to_user_id: int | None = None,
        page: int = 1,
        page_size: int = 20,
        personal_user_id: int | None = None,
    ) -> tuple[list[dict], int]:
        """One row per contact that has at least one WhatsApp interaction, most-recent first."""
        page = max(1, page)
        page_size = min(max(1, page_size), 100)

        from sqlalchemy import func as sa_func, or_

        meta_condition = self._whatsapp_thread_filter(personal_user_id=personal_user_id)

        latest_q = (
            db.query(
                Interaction.contact_id.label("contact_id"),
                sa_func.max(Interaction.created_at).label("last_at"),
            )
            .filter(meta_condition)
        )
        if assigned_to_user_id is not None:
            latest_q = (
                latest_q.join(Contact, Interaction.contact_id == Contact.id)
                .join(Buyer, Contact.buyer_id == Buyer.id)
                .filter(Buyer.assigned_to_user_id == assigned_to_user_id)
            )
        if assigned_to_user_id is not None:
            total = (
                db.query(sa_func.count(sa_func.distinct(Interaction.contact_id)))
                .join(Contact, Interaction.contact_id == Contact.id)
                .join(Buyer, Contact.buyer_id == Buyer.id)
                .filter(meta_condition, Buyer.assigned_to_user_id == assigned_to_user_id)
                .scalar()
                or 0
            )
        else:
            total = (
                db.query(sa_func.count(sa_func.distinct(Interaction.contact_id)))
                .filter(meta_condition)
                .scalar()
                or 0
            )
        latest_sub = latest_q.group_by(Interaction.contact_id).subquery()

        rows = (
            db.query(latest_sub)
            .order_by(latest_sub.c.last_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )

        contact_ids = [r.contact_id for r in rows if r.contact_id is not None]
        if not contact_ids:
            return [], total

        # Batch load contacts with buyers
        contacts = (
            db.query(Contact)
            .filter(Contact.id.in_(contact_ids))
            .all()
        )
        contacts_by_id = {c.id: c for c in contacts}
        buyer_ids = [c.buyer_id for c in contacts if c.buyer_id]
        buyers_by_id = {}
        if buyer_ids:
            buyers = db.query(Buyer).filter(Buyer.id.in_(buyer_ids)).all()
            buyers_by_id = {b.id: b for b in buyers}

        # Batch load the most recent Meta interaction for each contact
        recent_interactions = (
            db.query(Interaction)
            .filter(
                Interaction.contact_id.in_(contact_ids),
                meta_condition,
            )
            .order_by(Interaction.created_at.desc())
            .all()
        )
        latest_interaction_by_contact: dict[int, Interaction] = {}
        for ix in recent_interactions:
            if ix.contact_id and ix.contact_id not in latest_interaction_by_contact:
                latest_interaction_by_contact[ix.contact_id] = ix

        def _is_clean_name(val: str | None, phone_str: str | None = None) -> bool:
            if not val:
                return False
            s = str(val).strip()
            if not s:
                return False
            stripped = "".join(ch for ch in s if ch.isalnum())
            if not stripped or stripped.isdigit():
                return False
            if phone_str:
                p_digits = "".join(ch for ch in phone_str if ch.isdigit())
                s_digits = "".join(ch for ch in s if ch.isdigit())
                if p_digits and s_digits and p_digits == s_digits:
                    return False
            return True

        # Pre-lookup master contacts for any inbound/unresolved contacts by phone
        phone_to_master: dict[str, tuple[str | None, str | None]] = {}
        candidate_phones: set[str] = set()
        for cid in contact_ids:
            c = contacts_by_id.get(cid)
            if c:
                raw_phone = (c.phone or c.wa_id or "").strip()
                digits = "".join(ch for ch in raw_phone if ch.isdigit())
                if digits:
                    candidate_phones.add(digits)
                    if len(digits) >= 10:
                        candidate_phones.add(digits[-10:])

        if candidate_phones:
            phone_filters = []
            for p in list(candidate_phones)[:40]:
                phone_filters.append(Contact.phone.like(f"%{p}%"))
                phone_filters.append(Contact.wa_id.like(f"%{p}%"))

            master_matches = (
                db.query(Contact)
                .join(Buyer, Contact.buyer_id == Buyer.id)
                .filter(
                    Contact.data_source != "whatsapp_inbound",
                    or_(*phone_filters),
                )
                .limit(50)
                .all()
            )
            for mc in master_matches:
                for ph in (mc.phone, mc.wa_id, mc.primary_phone, mc.secondary_mobile):
                    if not ph:
                        continue
                    digs = "".join(ch for ch in ph if ch.isdigit())
                    if not digs:
                        continue
                    mbuyer = mc.buyer
                    cname = mc.full_name if _is_clean_name(mc.full_name, ph) else None
                    comp = mbuyer.company_name if mbuyer and _is_clean_name(mbuyer.company_name, ph) else None
                    if cname or comp:
                        phone_to_master[digs] = (cname, comp)
                        if len(digs) >= 10:
                            phone_to_master[digs[-10:]] = (cname, comp)

        conversations: list[dict] = []
        now_utc = datetime.now(timezone.utc)
        for row in rows:
            if not row.contact_id:
                continue
            contact = contacts_by_id.get(row.contact_id)
            if not contact:
                continue
            buyer = buyers_by_id.get(contact.buyer_id)
            last_message = latest_interaction_by_contact.get(contact.id)
            expires = contact.whatsapp_window_expires_at
            if expires is not None and expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            within_window = contact_within_whatsapp_session_window(db, contact)

            contact_phone = contact.wa_id or contact.phone
            contact_name = contact.full_name if _is_clean_name(contact.full_name, contact_phone) else None
            company_name = buyer.company_name if (buyer and _is_clean_name(buyer.company_name, contact_phone)) else None

            # Fallback to master contact list match if available
            raw_digs = "".join(ch for ch in (contact_phone or "") if ch.isdigit())
            master_info = phone_to_master.get(raw_digs) or (phone_to_master.get(raw_digs[-10:]) if len(raw_digs) >= 10 else None)
            if master_info:
                master_cname, master_comp = master_info
                if not contact_name and master_cname:
                    contact_name = master_cname
                if not company_name and master_comp:
                    company_name = master_comp

            conversations.append(
                {
                    "contact_id": contact.id,
                    "buyer_id": contact.buyer_id,
                    "company_name": company_name,
                    "contact_name": contact_name,
                    "contact_phone": contact_phone,
                    "whatsapp_opt_in": contact.whatsapp_opt_in,
                    "within_session_window": within_window,
                    "window_expires_at": contact.whatsapp_window_expires_at,
                    "last_message": last_message.content if last_message else None,
                    "last_message_at": last_message.created_at if last_message else None,
                    "last_direction": (
                        last_message.direction.value
                        if (last_message and hasattr(last_message.direction, "value"))
                        else (str(last_message.direction) if last_message else None)
                    ),
                }
            )
        return conversations, total

    def list_whatsapp_messages(
        self,
        db: Session,
        *,
        contact_id: int,
        limit: int = 200,
        personal_user_id: int | None = None,
    ) -> list[Interaction]:
        meta_condition = self._whatsapp_thread_filter(personal_user_id=personal_user_id) & (
            Interaction.contact_id == contact_id
        )
        return (
            db.query(Interaction)
            .filter(meta_condition)
            .order_by(Interaction.created_at.asc())
            .limit(limit)
            .all()
        )

    def get_whatsapp_buyer_preview(
        self,
        db: Session,
        *,
        buyer_id: int,
        recent: int = 3,
    ) -> dict:
        """Recent WhatsApp messages for a buyer profile card (most-active contact)."""
        from sqlalchemy import func as sa_func

        recent = max(1, min(int(recent or 3), 10))
        latest = (
            db.query(
                Interaction.contact_id.label("contact_id"),
                sa_func.max(Interaction.created_at).label("last_at"),
            )
            .join(Contact, Contact.id == Interaction.contact_id)
            .filter(
                Contact.buyer_id == buyer_id,
                Interaction.channel == Channel.whatsapp,
            )
            .group_by(Interaction.contact_id)
            .order_by(sa_func.max(Interaction.created_at).desc())
            .first()
        )
        if not latest:
            return {
                "buyer_id": buyer_id,
                "contact_id": None,
                "contact_name": None,
                "contact_phone": None,
                "within_session_window": False,
                "total_messages": 0,
                "messages": [],
            }

        contact = db.get(Contact, latest.contact_id)
        if not contact:
            return {
                "buyer_id": buyer_id,
                "contact_id": None,
                "contact_name": None,
                "contact_phone": None,
                "within_session_window": False,
                "total_messages": 0,
                "messages": [],
            }

        total = (
            db.query(Interaction)
            .filter(
                Interaction.contact_id == contact.id,
                Interaction.channel == Channel.whatsapp,
            )
            .count()
        )
        # Newest first, then reverse so the preview reads like a short chat.
        newest = (
            db.query(Interaction)
            .filter(
                Interaction.contact_id == contact.id,
                Interaction.channel == Channel.whatsapp,
            )
            .order_by(Interaction.created_at.desc())
            .limit(recent)
            .all()
        )
        messages = list(reversed(newest))

        expires = contact.whatsapp_window_expires_at
        if expires is not None and expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        within_window = contact_within_whatsapp_session_window(db, contact)

        return {
            "buyer_id": buyer_id,
            "contact_id": contact.id,
            "contact_name": contact.full_name,
            "contact_phone": contact.wa_id or contact.phone,
            "within_session_window": within_window,
            "total_messages": total,
            "messages": messages,
        }

    def update_whatsapp_message_status(
        self,
        db: Session,
        *,
        provider_message_id: str,
        status: str,
        error_message: str | None = None,
    ) -> Interaction | None:
        interaction = (
            db.query(Interaction)
            .filter(Interaction.provider_message_id == provider_message_id)
            .first()
        )
        if not interaction:
            return None
        interaction.wa_status = status
        if status == "failed" and error_message:
            raw_err = (error_message or "").strip()
            lower = raw_err.lower()
            if "re-engagement" in lower or "131047" in lower or "24 hour" in lower:
                mismatch = whatsapp_phone_number_id_mismatch()
                friendly = (
                    "Meta blocked delivery (Re-engagement / closed 24h window). "
                    "Ask the customer to message again, then reply within 24h — "
                    "or send an approved template. "
                    "Also confirm WHATSAPP_PHONE_NUMBER_ID matches the number that received their message."
                )
                if mismatch:
                    friendly = f"{friendly} {mismatch}"
                raw_err = friendly
            atts = [
                a
                for a in (interaction.attachments or [])
                if not (isinstance(a, dict) and a.get("type") == "whatsapp_send")
            ]
            atts.append(
                {
                    "type": "whatsapp_send",
                    "last_send_error": raw_err,
                }
            )
            interaction.attachments = atts
            # Meta often accepts (wamid) then fails delivery (e.g. billing 131042).
            # Keep the bubble visible as draft so reps can retry after fixing Meta.
            if interaction.status == InteractionStatus.sent:
                interaction.status = InteractionStatus.draft
        db.commit()
        db.refresh(interaction)
        return interaction

    def _await_whatsapp_cloud_outcome(
        self,
        db: Session,
        draft: Interaction,
        *,
        timeout_seconds: float = 12.0,
        poll_seconds: float = 1.0,
    ) -> Interaction:
        """Wait briefly for Meta delivery webhooks (delivered / read / failed).

        Graph ``accepted`` is not delivery. Billing/eligibility failures often arrive
        within a few seconds via webhook — without this wait the UI lies with "sent".
        """
        import time

        deadline = time.monotonic() + max(0.0, timeout_seconds)
        current = draft
        while time.monotonic() < deadline:
            db.expire(current)
            fresh = db.get(Interaction, current.id)
            if fresh is None:
                return current
            current = fresh
            status = (current.wa_status or "").lower()
            if status in {"delivered", "read", "failed"}:
                return current
            time.sleep(max(0.2, poll_seconds))
        db.expire(current)
        return db.get(Interaction, current.id) or current

    def create_whatsapp_campaign_drafts(
        self,
        db: Session,
        *,
        buyer_ids: list[int],
        template_id: int,
        template_variables: list[str] | None = None,
        require_opt_in: bool = False,
        send: bool = True,
        user_id: int | None = None,
        to_phone: str | None = None,
    ) -> dict:
        import time

        from config import settings
        from modules import email_activity
        from modules import whatsapp_templates as templates_module

        # Bulk WhatsApp always delivers immediately (approval queue removed).
        send = True

        template = templates_module.get_template(db, template_id)
        if not template:
            raise ValueError("WhatsApp template not found")
        from db.models import WhatsAppTemplateStatus

        if template.status != WhatsAppTemplateStatus.approved:
            raise ValueError(
                f"Template '{template.name}' is not approved by Meta yet "
                f"(status: {template.status.value})"
            )

        variables = template_variables or []

        created: list[dict] = []
        skipped: list[dict] = []
        sent_count = 0
        failed_count = 0
        is_bulk_batch = send and len(buyer_ids) > 1
        record_each = send and not is_bulk_batch

        if is_bulk_batch:
            email_activity.record_event(
                db,
                event_type="bulk_started",
                title=f"Bulk WhatsApp send started ({len(buyer_ids)} leads)",
                message=f"Sending approved template '{template.name}'. "
                "Per-message updates are summarized when the batch finishes.",
                user_id=user_id,
                details={"buyer_ids": buyer_ids, "template_id": template_id, "channel": "whatsapp"},
            )

        for index, buyer_id in enumerate(buyer_ids):
            buyer = db.get(Buyer, buyer_id)
            if not buyer:
                skipped.append({"buyer_id": buyer_id, "reason": "lead not found"})
                continue
            try:
                from modules import buyers as buyers_module

                contact = buyers_module.primary_contact_with_phone(db, buyer_id)
                if not contact:
                    raise ValueError(f"No contact with a phone number for {buyer.company_name}")
                if (
                    require_opt_in
                    and template.category
                    and template.category.upper() == "MARKETING"
                    and not contact.whatsapp_opt_in
                ):
                    raise ValueError(
                        f"{buyer.company_name} contact has not opted in to WhatsApp marketing"
                    )

                if template.body_text and template.variable_count > 0:
                    buyer_variables = templates_module.merge_template_variables(
                        variables,
                        templates_module.suggest_template_variables(
                            template.body_text,
                            template.variable_count,
                            contact_name=contact.full_name,
                            company_name=buyer.company_name,
                            country=buyer.country,
                        ),
                    )
                else:
                    buyer_variables = variables

                rendered_body = (
                    templates_module.render_variables(template.body_text, buyer_variables)
                    if template.body_text
                    else template.name
                )

                draft = Interaction(
                    contact_id=contact.id,
                    channel=Channel.whatsapp,
                    direction=Direction.outbound,
                    content=rendered_body,
                    language=contact.preferred_language or "en",
                    handled_by=HandledBy.human,
                    status=InteractionStatus.draft,
                    template_name=template.name,
                )
                db.add(draft)
                db.commit()
                db.refresh(draft)

                item = {
                    "buyer_id": buyer_id,
                    "company_name": buyer.company_name,
                    "contact_name": getattr(contact, "full_name", None),
                    "phone": (
                        getattr(contact, "phone", None)
                        or getattr(contact, "primary_phone", None)
                        or getattr(contact, "secondary_mobile", None)
                        or getattr(contact, "secondary_phone", None)
                    ),
                    "to_email": contact.email,
                    "interaction_id": draft.id,
                    "contact_id": draft.contact_id,
                    "sent": False,
                    "send_status": None,
                    "send_message": None,
                }
                if send:
                    force_phone = None
                    if to_phone and len(buyer_ids) == 1:
                        force_phone = to_phone.strip() or None
                    _approved, send_result = self.approve_draft(
                        db,
                        draft.id,
                        approved_by="dashboard_user",
                        send=True,
                        record_activity=record_each,
                        template_name=template.name,
                        template_language=template.language or "en_US",
                        template_variables=buyer_variables,
                        user_id=user_id,
                        force_phone=force_phone,
                    )
                    status = (send_result or {}).get("status")
                    item["sent"] = status == "sent"
                    item["send_status"] = status
                    item["send_message"] = (send_result or {}).get("message")
                    if status == "sent":
                        sent_count += 1
                    else:
                        failed_count += 1
                    if (
                        index < len(buyer_ids) - 1
                        and settings.bulk_whatsapp_message_delay_seconds > 0
                    ):
                        time.sleep(settings.bulk_whatsapp_message_delay_seconds)
                created.append(item)
            except ValueError as exc:
                reason = str(exc)
                skipped.append(
                    {"buyer_id": buyer_id, "company_name": buyer.company_name, "reason": reason}
                )
                if record_each:
                    email_activity.record_event(
                        db,
                        event_type="send_failed",
                        title=f"Skipped — {buyer.company_name}",
                        message=reason,
                        buyer_id=buyer_id,
                        user_id=user_id,
                        details={"reason": reason, "channel": "whatsapp"},
                    )

        # Reconcile Graph "accepted" rows that Meta later failed via webhook
        # (common: Business eligibility payment issue / 131042).
        if send and created:
            time.sleep(8.0 if is_bulk_batch else 0.0)
            for item in created:
                if not item.get("sent"):
                    continue
                ix = db.get(Interaction, item.get("interaction_id"))
                if not ix:
                    continue
                db.refresh(ix)
                if (ix.wa_status or "").lower() != "failed":
                    continue
                err = (
                    whatsapp_send_error(ix.attachments)
                    or "WhatsApp delivery failed after Meta accepted the message"
                )
                item["sent"] = False
                item["send_status"] = "error"
                item["send_message"] = err
                sent_count = max(0, sent_count - 1)
                failed_count += 1

        delivery_error = next(
            (
                (item.get("send_message") or "").strip()
                for item in created
                if item.get("send_status") == "error" and (item.get("send_message") or "").strip()
            ),
            None,
        )

        if is_bulk_batch:
            if failed_count > 0 and sent_count > 0:
                event_type = "bulk_partial"
                title = f"Bulk WhatsApp send partial — {sent_count} sent, {failed_count} failed"
            elif failed_count > 0 and sent_count == 0:
                event_type = "send_failed"
                title = f"Bulk WhatsApp send failed — 0 of {len(buyer_ids)} sent"
            else:
                event_type = "bulk_completed"
                title = f"Bulk WhatsApp send completed — {sent_count} sent"
            email_activity.record_event(
                db,
                event_type=event_type,
                title=title,
                message=(
                    f"{sent_count} sent, {failed_count} failed, {len(skipped)} skipped "
                    f"out of {len(buyer_ids)} selected."
                    + (f" First error: {delivery_error}" if delivery_error else "")
                ),
                user_id=user_id,
                details={
                    "sent_count": sent_count,
                    "failed_count": failed_count,
                    "skipped_count": len(skipped),
                    "selected_count": len(buyer_ids),
                    "template_id": template_id,
                    "channel": "whatsapp",
                    "skipped": skipped[:20],
                    "delivery_error": delivery_error,
                    # Per-contact outcome for the "View results" window in WhatsApp Activity.
                    "results": _bulk_results_detail(created, skipped),
                },
            )

        return {
            "created_count": len(created),
            "skipped_count": len(skipped),
            "sent_count": sent_count,
            "failed_count": failed_count,
            "created": created,
            "skipped": skipped,
            "delivery_error": delivery_error,
        }

    def approve_draft(
        self,
        db: Session,
        interaction_id: int,
        *,
        content: str | None = None,
        approved_by: str = "sales_rep",
        send: bool = True,
        record_activity: bool = True,
        send_mode: str = "individual",
        template_name: str | None = None,
        template_language: str = "en_US",
        template_variables: list[str] | None = None,
        mailbox_user=None,
        user_id: int | None = None,
        force_phone: str | None = None,
        force_email: str | None = None,
    ) -> tuple[Interaction, dict | None]:
        draft = db.get(Interaction, interaction_id)
        if not draft:
            raise ValueError("Interaction not found")
        if draft.status not in (InteractionStatus.draft, InteractionStatus.approved):
            raise ValueError(f"Cannot approve interaction in status {draft.status}")

        if content:
            draft.content = content
        draft.status = InteractionStatus.approved
        draft.approved_by = approved_by
        db.commit()
        db.refresh(draft)

        send_result: dict | None = None
        if send and draft.channel == Channel.email:
            send_result = self._send_email_draft(
                db,
                draft,
                record_activity=record_activity,
                send_mode=send_mode,
                mailbox_user=mailbox_user,
                force_email=force_email,
            )
        elif send and draft.channel == Channel.whatsapp:
            send_result = self._send_whatsapp_draft(
                db,
                draft,
                record_activity=record_activity,
                template_name=template_name or draft.template_name,
                template_language=template_language,
                template_variables=template_variables,
                user_id=user_id,
                force_phone=force_phone,
            )

        return draft, send_result

    def _send_email_draft(
        self,
        db: Session,
        draft: Interaction,
        *,
        record_activity: bool,
        send_mode: str = "individual",
        mailbox_user=None,
        force_email: str | None = None,
    ) -> dict:
        contact = db.get(Contact, draft.contact_id)
        to_email = (force_email or "").strip() or (
            (contact.email or "").strip() if contact else ""
        )
        if not to_email:
            if record_activity:
                from modules import email_activity

                buyer = db.get(Buyer, contact.buyer_id) if contact else None
                email_activity.record_event(
                    db,
                    event_type="invalid_recipient",
                    title=f"Invalid recipient — {buyer.company_name if buyer else 'lead'}",
                    message="Contact has no email address — cannot send.",
                    buyer_id=contact.buyer_id if contact else None,
                    contact_id=draft.contact_id,
                    interaction_id=draft.id,
                    details={"send_mode": send_mode},
                    mailbox_user=mailbox_user,
                )
            raise ValueError("Contact has no email address — cannot send")

        mode = "bulk" if send_mode == "bulk" else "individual"
        send_result = mail_client.send_approved(
            to=to_email,
            subject=draft.subject or "Kafi Commodities",
            body=draft.content,
            attachments=draft.attachments or [],
            interaction_id=draft.id,
            send_mode=mode,
            mailbox_user=mailbox_user,
        )
        if send_result.get("status") == "sent":
            draft.status = InteractionStatus.sent
            db.commit()
            db.refresh(draft)

        if record_activity:
            from modules import email_activity

            buyer = db.get(Buyer, contact.buyer_id) if contact else None
            email_activity.record_send_result(
                db,
                send_result=send_result,
                company_name=buyer.company_name if buyer else "Unknown",
                to_email=to_email,
                buyer_id=contact.buyer_id if contact else None,
                contact_id=contact.id if contact else None,
                interaction_id=draft.id,
                subject=draft.subject,
                send_mode=mode,
                mailbox_user=mailbox_user,
            )
        return send_result

    def _send_whatsapp_draft(
        self,
        db: Session,
        draft: Interaction,
        *,
        record_activity: bool,
        template_name: str | None,
        template_language: str,
        template_variables: list[str] | None,
        user_id: int | None = None,
        force_phone: str | None = None,
    ) -> dict:
        from modules import email_activity

        contact = db.get(Contact, draft.contact_id)
        buyer = db.get(Buyer, contact.buyer_id) if contact else None
        phone = None
        if force_phone and str(force_phone).strip():
            from integrations.voice_client import normalize_e164

            phone = normalize_e164(str(force_phone).strip())
            if not phone:
                digits = "".join(ch for ch in str(force_phone) if ch.isdigit())
                if digits:
                    phone = f"+{digits}"
        if not phone and contact:
            from integrations.voice_client import normalize_e164

            # Prefer Meta wa_id — contact.phone is often a landline / display number
            # that Graph accepts but never delivers on WhatsApp.
            raw_candidates = [
                contact.wa_id,
                contact.primary_phone,
                contact.secondary_mobile,
                contact.phone,
            ]
            for raw in raw_candidates:
                if not raw or not str(raw).strip():
                    continue
                phone = normalize_e164(str(raw).strip())
                if phone:
                    break
                digits = "".join(ch for ch in str(raw) if ch.isdigit())
                if digits:
                    phone = f"+{digits}"
                    break

        if not contact or not phone:
            draft.status = InteractionStatus.draft
            draft.wa_status = "failed"
            atts = [
                a
                for a in (draft.attachments or [])
                if not (isinstance(a, dict) and a.get("type") == "whatsapp_send")
            ]
            atts.append(
                {
                    "type": "whatsapp_send",
                    "last_send_error": "Contact has no phone / WhatsApp number — cannot send.",
                }
            )
            draft.attachments = atts
            db.commit()
            if record_activity:
                email_activity.record_event(
                    db,
                    event_type="invalid_recipient",
                    title=f"WhatsApp invalid recipient — {buyer.company_name if buyer else 'lead'}",
                    message="Contact has no phone number — cannot send WhatsApp message.",
                    buyer_id=contact.buyer_id if contact else None,
                    contact_id=draft.contact_id,
                    interaction_id=draft.id,
                    details={"channel": "whatsapp"},
                )
            raise ValueError("Contact has no phone number — cannot send WhatsApp message")

        expires = contact.whatsapp_window_expires_at
        if expires is not None and expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        within_window = contact_within_whatsapp_session_window(db, contact)

        components = None
        send_language = template_language or "en_US"
        if template_name:
            from modules import whatsapp_templates as templates_module
            from db.models import WhatsAppTemplate

            template_row = (
                db.query(WhatsAppTemplate)
                .filter(WhatsAppTemplate.name == template_name)
                .order_by(WhatsAppTemplate.id.desc())
                .first()
            )
            if template_row and template_row.language:
                send_language = template_row.language
            components = templates_module.build_template_send_components(
                template_row,
                template_variables or [],
            ) or None

        # Keep the outbound row visible in Cloud inbox while Meta processes it.
        # Without wa_status / template_name / wamid, failed "approved" drafts vanish from the thread.
        draft.template_name = template_name or draft.template_name
        draft.wa_status = "pending"
        atts = [
            a
            for a in (draft.attachments or [])
            if not (isinstance(a, dict) and a.get("type") == "whatsapp_send")
        ]
        atts.append({"type": "whatsapp_send", "to": phone})
        draft.attachments = atts
        db.commit()

        # Reply in-thread to the customer's latest Cloud inbound (helps Meta session).
        context_wamid = None
        if within_window and not template_name:
            last_in = (
                db.query(Interaction)
                .filter(
                    Interaction.contact_id == contact.id,
                    Interaction.channel == Channel.whatsapp,
                    Interaction.direction == Direction.inbound,
                    Interaction.personal_whatsapp_user_id.is_(None),
                    Interaction.provider_message_id.isnot(None),
                )
                .order_by(Interaction.created_at.desc())
                .first()
            )
            if last_in and (last_in.provider_message_id or "").startswith("wamid"):
                context_wamid = last_in.provider_message_id

        send_result = whatsapp_client.send_approved(
            phone=phone,
            message=draft.content,
            template_name=template_name,
            template_language=send_language,
            template_components=components,
            within_session_window=within_window,
            context_message_id=context_wamid,
        )

        if send_result.get("status") == "sent":
            draft.status = InteractionStatus.sent
            draft.provider_message_id = send_result.get("provider_message_id")
            draft.template_name = template_name or draft.template_name
            draft.wa_status = "sent"
            db.commit()
            db.refresh(draft)
            # Billing / eligibility failures arrive via webhook after Graph "accepted".
            # Wait briefly so bulk/individual UI does not report false success.
            draft = self._await_whatsapp_cloud_outcome(
                db,
                draft,
                # Single sends wait longer; bulk relies on end-of-batch reconcile.
                timeout_seconds=12.0 if record_activity else 2.0,
            )
            if (draft.wa_status or "").lower() == "failed":
                err = (
                    whatsapp_send_error(draft.attachments)
                    or "WhatsApp delivery failed after Meta accepted the message"
                )
                send_result = {
                    "status": "error",
                    "message": err,
                    "provider_message_id": draft.provider_message_id,
                }
                if draft.status == InteractionStatus.sent:
                    draft.status = InteractionStatus.draft
                    db.commit()
                    db.refresh(draft)
        else:
            # Revert approved → draft so the rep can retry; keep wa_status=failed for inbox visibility.
            draft.status = InteractionStatus.draft
            draft.wa_status = "failed"
            atts = [
                a
                for a in (draft.attachments or [])
                if not (isinstance(a, dict) and a.get("type") == "whatsapp_send")
            ]
            atts.append(
                {
                    "type": "whatsapp_send",
                    "to": phone,
                    "last_send_error": send_result.get("message") or "WhatsApp send failed",
                }
            )
            draft.attachments = atts
            db.commit()
            db.refresh(draft)

        if record_activity:
            event_type = "sent" if send_result.get("status") == "sent" else "send_failed"
            email_activity.record_event(
                db,
                event_type=event_type,
                title=(
                    f"WhatsApp sent — {buyer.company_name if buyer else 'lead'}"
                    if event_type == "sent"
                    else f"WhatsApp send failed — {buyer.company_name if buyer else 'lead'}"
                ),
                message=send_result.get("message") or "",
                user_id=user_id,
                buyer_id=contact.buyer_id,
                contact_id=contact.id,
                interaction_id=draft.id,
                details={
                    "channel": "whatsapp",
                    "template_name": template_name,
                    "to": phone,
                },
            )
        return send_result

    def reject_draft(self, db: Session, interaction_id: int) -> Interaction:
        draft = db.get(Interaction, interaction_id)
        if not draft:
            raise ValueError("Interaction not found")
        draft.status = InteractionStatus.rejected
        db.commit()
        db.refresh(draft)
        return draft

    def list_drafts(
        self,
        db: Session,
        *,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[Interaction], int]:
        page = max(1, page)
        page_size = min(max(1, page_size), 100)
        base_query = db.query(Interaction).filter(
            Interaction.status == InteractionStatus.draft
        )
        total = base_query.count()
        drafts = (
            base_query.order_by(Interaction.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        return drafts, total

    def update_draft_attachments(
        self,
        db: Session,
        interaction_id: int,
        attachments: list[dict],
    ) -> Interaction:
        draft = db.get(Interaction, interaction_id)
        if not draft:
            raise ValueError("Interaction not found")
        if draft.status != InteractionStatus.draft:
            raise ValueError("Can only edit attachments on draft interactions")
        if draft.channel != Channel.email:
            raise ValueError("Attachments are only supported for email drafts")
        draft.attachments = resolve_attachment_list(attachments, draft.attachments)
        db.commit()
        db.refresh(draft)
        return draft

    def create_manual_email_draft(
        self,
        db: Session,
        *,
        buyer_id: int,
        subject: str,
        body: str,
        contact_id: int | None = None,
        attachments: list[dict] | None = None,
    ) -> Interaction:
        from modules import buyers as buyers_module

        buyer = db.get(Buyer, buyer_id)
        if not buyer:
            raise ValueError(f"Buyer {buyer_id} not found")

        subject_clean = (subject or "").strip()
        body_clean = (body or "").strip()
        if not subject_clean:
            raise ValueError("Subject is required")
        if not body_clean:
            raise ValueError("Email body is required")

        contact: Contact | None = None
        if contact_id is not None:
            contact = db.get(Contact, contact_id)
            if not contact or contact.buyer_id != buyer_id:
                raise ValueError("Contact not found for this lead")
            if not (contact.email or "").strip():
                raise ValueError("Selected contact has no email address")
        else:
            contact = buyers_module.primary_contact_with_email(db, buyer_id)
            if not contact:
                raise ValueError(f"No contact with email for {buyer.company_name}")

        draft = Interaction(
            contact_id=contact.id,
            channel=Channel.email,
            direction=Direction.outbound,
            subject=subject_clean,
            content=body_clean,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.human,
            status=InteractionStatus.draft,
            attachments=copy_attachments(resolve_attachment_list(attachments)),
        )
        db.add(draft)
        db.commit()
        db.refresh(draft)
        return draft

    def generate_draft_from_template(
        self,
        db: Session,
        *,
        buyer_id: int,
        template_id: int,
        extra_attachments: list[dict] | None = None,
    ) -> Interaction:
        from modules import buyers as buyers_module
        from modules.email_templates import get_template, render_template_text

        buyer = db.get(Buyer, buyer_id)
        if not buyer:
            raise ValueError(f"Buyer {buyer_id} not found")

        template = get_template(db, template_id)
        if not template:
            raise ValueError("Email template not found")

        contact = buyers_module.primary_contact_with_email(db, buyer_id)
        if not contact:
            raise ValueError(f"No contact with email for {buyer.company_name}")

        subject = render_template_text(template.subject, buyer=buyer, contact=contact)
        body = render_template_text(template.body, buyer=buyer, contact=contact)
        try:
            attachments = merge_attachments(
                resolve_attachment_list(template.attachments),
                resolve_attachment_list(extra_attachments),
            )
            draft_attachments = copy_attachments(resolve_attachment_list(attachments))
        except FileNotFoundError as exc:
            raise ValueError(str(exc)) from exc
        if (template.attachments or extra_attachments) and not draft_attachments:
            raise ValueError(
                "Template attachments could not be loaded from disk. "
                "Re-attach the file on the email template and save again."
            )

        draft = Interaction(
            contact_id=contact.id,
            channel=Channel.email,
            direction=Direction.outbound,
            subject=subject,
            content=body,
            language=contact.preferred_language or "en",
            handled_by=HandledBy.agent,
            status=InteractionStatus.draft,
            attachments=draft_attachments,
        )
        db.add(draft)
        db.commit()
        db.refresh(draft)
        return draft

    def create_bulk_manual_drafts(
        self,
        db: Session,
        *,
        buyer_ids: list[int],
        subject: str,
        body: str,
        attachments: list[dict] | None = None,
        send: bool = True,
        mailbox_user=None,
    ) -> dict:
        import time

        from config import settings
        from modules import buyers as buyers_module, email_activity
        from modules.email_templates import render_template_text

        subject_clean = (subject or "").strip()
        body_clean = (body or "").strip()
        if not subject_clean:
            raise ValueError("Subject is required")
        if not body_clean:
            raise ValueError("Email body is required")

        # Bulk compose always delivers immediately (approval queue removed for email).
        send = True

        created: list[dict] = []
        skipped: list[dict] = []
        sent_count = 0
        failed_count = 0
        is_bulk_batch = send and len(buyer_ids) > 1
        record_each = send and not is_bulk_batch

        if is_bulk_batch:
            email_activity.record_event(
                db,
                event_type="bulk_started",
                title=f"Bulk send started ({len(buyer_ids)} leads)",
                message="Sending personalized manual emails. Per-message updates are summarized when the batch finishes.",
                details={"buyer_ids": buyer_ids, "mode": "manual"},
                mailbox_user=mailbox_user,
            )

        for index, buyer_id in enumerate(buyer_ids):
            buyer = db.get(Buyer, buyer_id)
            if not buyer:
                skipped.append({"buyer_id": buyer_id, "reason": "lead not found"})
                continue
            try:
                contact = buyers_module.primary_contact_with_email(db, buyer_id)
                if not contact:
                    raise ValueError(f"No contact with email for {buyer.company_name}")

                subject_rendered = render_template_text(subject_clean, buyer=buyer, contact=contact)
                body_rendered = render_template_text(body_clean, buyer=buyer, contact=contact)

                draft = Interaction(
                    contact_id=contact.id,
                    channel=Channel.email,
                    direction=Direction.outbound,
                    subject=subject_rendered,
                    content=body_rendered,
                    language=contact.preferred_language or "en",
                    handled_by=HandledBy.human,
                    status=InteractionStatus.draft,
                    attachments=copy_attachments(resolve_attachment_list(attachments)),
                )
                db.add(draft)
                db.commit()
                db.refresh(draft)

                item = {
                    "buyer_id": buyer_id,
                    "company_name": buyer.company_name,
                    "to_email": contact.email,
                    "interaction_id": draft.id,
                    "contact_id": draft.contact_id,
                    "sent": False,
                    "send_status": None,
                    "send_message": None,
                }
                if send:
                    _approved, send_result = self.approve_draft(
                        db,
                        draft.id,
                        approved_by="dashboard_user",
                        send=True,
                        record_activity=record_each,
                        send_mode="bulk" if is_bulk_batch else "individual",
                        mailbox_user=mailbox_user,
                    )
                    status = (send_result or {}).get("status")
                    item["sent"] = status == "sent"
                    item["send_status"] = status
                    item["send_message"] = (send_result or {}).get("message")
                    if status == "sent":
                        sent_count += 1
                    else:
                        failed_count += 1
                    if index < len(buyer_ids) - 1 and settings.bulk_email_message_delay_seconds > 0:
                        time.sleep(settings.bulk_email_message_delay_seconds)
                created.append(item)
            except ValueError as exc:
                reason = str(exc)
                skipped.append(
                    {
                        "buyer_id": buyer_id,
                        "company_name": buyer.company_name if buyer else None,
                        "reason": reason,
                    }
                )
                if record_each:
                    event_type = (
                        "skipped_no_email"
                        if "email" in reason.lower()
                        else "send_failed"
                    )
                    email_activity.record_event(
                        db,
                        event_type=event_type,
                        title=f"Skipped — {buyer.company_name if buyer else buyer_id}",
                        message=reason,
                        buyer_id=buyer_id,
                        details={"reason": reason},
                        mailbox_user=mailbox_user,
                    )

        if is_bulk_batch:
            if failed_count > 0 and sent_count > 0:
                event_type = "bulk_partial"
                title = f"Bulk send partial — {sent_count} sent, {failed_count} failed"
            elif failed_count > 0 and sent_count == 0 and len(skipped) == len(buyer_ids):
                event_type = "bulk_partial"
                title = f"Bulk send finished — all {len(skipped)} skipped"
            elif failed_count > 0 and sent_count == 0:
                event_type = "send_failed"
                title = f"Bulk send failed — 0 of {len(buyer_ids)} sent"
            else:
                event_type = "bulk_completed"
                title = f"Bulk send completed — {sent_count} sent"
            email_activity.record_event(
                db,
                event_type=event_type,
                title=title,
                message=(
                    f"{sent_count} sent, {failed_count} failed, {len(skipped)} skipped "
                    f"out of {len(buyer_ids)} selected."
                ),
                details={
                    "sent_count": sent_count,
                    "failed_count": failed_count,
                    "skipped_count": len(skipped),
                    "selected_count": len(buyer_ids),
                    "mode": "manual",
                    "send_mode": "bulk",
                    "mailbox_email": getattr(mailbox_user, "mailbox_email", None)
                    if mailbox_user
                    else None,
                    "skipped": skipped[:20],
                    "failures": [
                        {
                            "company_name": row.get("company_name"),
                            "to_email": row.get("to_email"),
                            "buyer_id": row.get("buyer_id"),
                            "send_status": row.get("send_status"),
                            "send_message": row.get("send_message"),
                            "error": row.get("send_message"),
                        }
                        for row in created
                        if not row.get("sent")
                    ][:50],
                },
                mailbox_user=mailbox_user,
            )

        return {
            "created_count": len(created),
            "skipped_count": len(skipped),
            "sent_count": sent_count,
            "failed_count": failed_count,
            "created": created,
            "skipped": skipped,
        }

    def create_bulk_drafts_from_template(
        self,
        db: Session,
        *,
        buyer_ids: list[int],
        template_id: int,
        extra_attachments: list[dict] | None = None,
        send: bool = True,
        mailbox_user=None,
    ) -> dict:
        import time

        from config import settings
        from modules import email_activity

        # Bulk compose always delivers immediately (approval queue removed for email).
        send = True

        created: list[dict] = []
        skipped: list[dict] = []
        sent_count = 0
        failed_count = 0
        # Multi-lead bulk: one start + one summary only (no per-email spam).
        is_bulk_batch = send and len(buyer_ids) > 1
        # Single-lead template send: keep normal per-email activity events.
        record_each = send and not is_bulk_batch

        if is_bulk_batch:
            email_activity.record_event(
                db,
                event_type="bulk_started",
                title=f"Bulk send started ({len(buyer_ids)} leads)",
                message="Sending personalized emails from the selected template. Per-message updates are summarized when the batch finishes.",
                details={"buyer_ids": buyer_ids, "template_id": template_id},
                mailbox_user=mailbox_user,
            )

        for index, buyer_id in enumerate(buyer_ids):
            buyer = db.get(Buyer, buyer_id)
            if not buyer:
                skipped.append({"buyer_id": buyer_id, "reason": "lead not found"})
                continue
            try:
                draft = self.generate_draft_from_template(
                    db,
                    buyer_id=buyer_id,
                    template_id=template_id,
                    extra_attachments=extra_attachments,
                )
                item = {
                    "buyer_id": buyer_id,
                    "company_name": buyer.company_name,
                    "to_email": contact.email,
                    "interaction_id": draft.id,
                    "contact_id": draft.contact_id,
                    "sent": False,
                    "send_status": None,
                    "send_message": None,
                }
                if send:
                    _approved, send_result = self.approve_draft(
                        db,
                        draft.id,
                        approved_by="dashboard_user",
                        send=True,
                        record_activity=record_each,
                        send_mode="bulk" if is_bulk_batch else "individual",
                        mailbox_user=mailbox_user,
                    )
                    status = (send_result or {}).get("status")
                    item["sent"] = status == "sent"
                    item["send_status"] = status
                    item["send_message"] = (send_result or {}).get("message")
                    if status == "sent":
                        sent_count += 1
                    else:
                        failed_count += 1
                    if index < len(buyer_ids) - 1 and settings.bulk_email_message_delay_seconds > 0:
                        time.sleep(settings.bulk_email_message_delay_seconds)
                created.append(item)
            except ValueError as exc:
                reason = str(exc)
                skipped.append(
                    {
                        "buyer_id": buyer_id,
                        "company_name": buyer.company_name,
                        "reason": reason,
                    }
                )
                if record_each:
                    event_type = (
                        "skipped_no_email"
                        if "email" in reason.lower()
                        else "send_failed"
                    )
                    email_activity.record_event(
                        db,
                        event_type=event_type,
                        title=f"Skipped — {buyer.company_name}",
                        message=reason,
                        buyer_id=buyer_id,
                        details={"reason": reason},
                        mailbox_user=mailbox_user,
                    )

        if is_bulk_batch:
            if failed_count > 0 and sent_count > 0:
                event_type = "bulk_partial"
                title = f"Bulk send partial — {sent_count} sent, {failed_count} failed"
            elif failed_count > 0 and sent_count == 0 and len(skipped) == len(buyer_ids):
                event_type = "bulk_partial"
                title = f"Bulk send finished — all {len(skipped)} skipped"
            elif failed_count > 0 and sent_count == 0:
                event_type = "send_failed"
                title = f"Bulk send failed — 0 of {len(buyer_ids)} sent"
            else:
                event_type = "bulk_completed"
                title = f"Bulk send completed — {sent_count} sent"
            email_activity.record_event(
                db,
                event_type=event_type,
                title=title,
                message=(
                    f"{sent_count} sent, {failed_count} failed, {len(skipped)} skipped "
                    f"out of {len(buyer_ids)} selected."
                ),
                details={
                    "sent_count": sent_count,
                    "failed_count": failed_count,
                    "skipped_count": len(skipped),
                    "selected_count": len(buyer_ids),
                    "template_id": template_id,
                    "mode": "manual",
                    "send_mode": "bulk",
                    "mailbox_email": getattr(mailbox_user, "mailbox_email", None)
                    if mailbox_user
                    else None,
                    "skipped": skipped[:20],
                    "failures": [
                        {
                            "company_name": row.get("company_name"),
                            "to_email": row.get("to_email"),
                            "buyer_id": row.get("buyer_id"),
                            "send_status": row.get("send_status"),
                            "send_message": row.get("send_message"),
                            "error": row.get("send_message"),
                        }
                        for row in created
                        if not row.get("sent")
                    ][:50],
                },
                mailbox_user=mailbox_user,
            )

        return {
            "created_count": len(created),
            "skipped_count": len(skipped),
            "sent_count": sent_count,
            "failed_count": failed_count,
            "created": created,
            "skipped": skipped,
        }

    def bulk_approve_drafts(
        self,
        db: Session,
        interaction_ids: list[int],
        *,
        approved_by: str = "sales_rep",
        send: bool = True,
        message_delay_seconds: float | None = None,
        mailbox_user=None,
    ) -> dict:
        import time

        from config import settings

        delay = (
            message_delay_seconds
            if message_delay_seconds is not None
            else settings.bulk_email_message_delay_seconds
        )

        results: list[dict] = []
        sent_count = 0
        failed_count = 0
        is_bulk_batch = send and len(interaction_ids) > 1

        if is_bulk_batch:
            from modules import email_activity

            email_activity.record_event(
                db,
                event_type="bulk_started",
                title=f"Bulk send started ({len(interaction_ids)} emails)",
                message="Sending selected emails. Per-message updates are summarized when the batch finishes.",
                details={"interaction_ids": interaction_ids},
                mailbox_user=mailbox_user,
            )

        for index, interaction_id in enumerate(interaction_ids):
            if index > 0 and send and delay > 0:
                time.sleep(delay)
            try:
                draft, send_result = self.approve_draft(
                    db,
                    interaction_id,
                    approved_by=approved_by,
                    send=send,
                    record_activity=not is_bulk_batch,
                    send_mode="bulk" if is_bulk_batch else "individual",
                    mailbox_user=mailbox_user,
                )
                sent = draft.status == InteractionStatus.sent
                if sent:
                    sent_count += 1
                elif send:
                    failed_count += 1
                results.append(
                    {
                        "interaction_id": interaction_id,
                        "status": draft.status.value,
                        "sent": sent,
                        "send_status": (send_result or {}).get("status"),
                        "send_message": (send_result or {}).get("message"),
                    }
                )
            except ValueError as exc:
                failed_count += 1
                results.append(
                    {
                        "interaction_id": interaction_id,
                        "status": "error",
                        "sent": False,
                        "send_message": str(exc),
                    }
                )

        if is_bulk_batch:
            from modules import email_activity

            if failed_count > 0 and sent_count > 0:
                event_type = "bulk_partial"
                title = f"Bulk send partial — {sent_count} sent, {failed_count} failed"
            elif failed_count > 0 and sent_count == 0:
                event_type = "send_failed"
                title = f"Bulk send failed — 0 of {len(interaction_ids)} sent"
            else:
                event_type = "bulk_completed"
                title = f"Bulk send completed — {sent_count} sent"
            email_activity.record_event(
                db,
                event_type=event_type,
                title=title,
                message=(
                    f"{sent_count} sent, {failed_count} failed "
                    f"out of {len(interaction_ids)} selected."
                ),
                details={
                    "sent_count": sent_count,
                    "failed_count": failed_count,
                    "selected_count": len(interaction_ids),
                },
                mailbox_user=mailbox_user,
            )

        return {
            "processed": len(results),
            "sent_count": sent_count,
            "failed_count": failed_count,
            "results": results,
        }

    def interaction_to_dict(self, db: Session, interaction: Interaction) -> dict:
        contact = db.get(Contact, interaction.contact_id)
        buyer = db.get(Buyer, contact.buyer_id) if contact else None
        return {
            "id": interaction.id,
            "contact_id": interaction.contact_id,
            "channel": interaction.channel.value,
            "direction": interaction.direction.value,
            "subject": interaction.subject,
            "content": interaction.content,
            "status": interaction.status.value,
            "created_at": interaction.created_at,
            "company_name": buyer.company_name if buyer else None,
            "contact_name": contact.full_name if contact else None,
            "contact_email": contact.email if contact else None,
            "contact_phone": contact.phone if contact else None,
            "template_name": interaction.template_name,
            "wa_status": interaction.wa_status,
            "wa_send_error": whatsapp_send_error(interaction.attachments),
            "attachments": public_attachments(interaction.attachments),
        }

    def list_interactions(self, db: Session, limit: int = 100) -> list[Interaction]:
        return (
            db.query(Interaction)
            .order_by(Interaction.created_at.desc())
            .limit(limit)
            .all()
        )


_comms = CommsGenerator()


def get_comms() -> CommsGenerator:
    return _comms
