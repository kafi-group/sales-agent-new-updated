from datetime import date, timedelta

from pathlib import Path



from sqlalchemy.orm import Session



from db.models import (

    Buyer,

    ExportHistory,

    LeadScoreLabel,

    Product,

    Quotation,

    QuotationLineItem,

    QuotationStatus,

)

from modules.carton_dimensions import lookup_for_product

from modules.pricing import price_tiers_for_category, price_unit_for_category

from modules.product_catalog import list_products, load_catalog, recommend_cross_sell_for_buyer

from modules.research import ResearchModule





class CommerceModule:

    """Quotation generation and upsell recommendations (rule-based)."""



    def __init__(self, storage_dir: str = "storage/quotations"):

        self.storage_dir = Path(storage_dir)

        self.storage_dir.mkdir(parents=True, exist_ok=True)



    def resolve_unit_price(

        self,

        product: Product,

        buyer_id: int,

        db: Session,

        tier: str = "standard",

    ) -> float:

        tiers = product.price_tiers or {}

        base = float(tiers.get(tier, tiers.get("standard", 0)))



        last_order = (

            db.query(ExportHistory)

            .filter(

                ExportHistory.buyer_id == buyer_id,

                ExportHistory.product_id == product.id,

            )

            .order_by(ExportHistory.order_date.desc())

            .first()

        )

        if last_order and last_order.unit_price:

            negotiated = float(last_order.unit_price)

            if negotiated < base:

                return negotiated

        return base

    def _unique_products(self, products: list[Product]) -> list[Product]:
        from modules.product_catalog import product_dedupe_key

        seen: dict[str, Product] = {}
        for product in products:
            key = product_dedupe_key(product.name)
            if key and key not in seen:
                seen[key] = product
        return sorted(seen.values(), key=lambda p: (p.category or "", p.name.lower()))

    def _canonical_product_by_key(self, db: Session) -> dict[str, Product]:
        from modules.product_catalog import product_dedupe_key

        canonical: dict[str, Product] = {}
        for product in db.query(Product).order_by(Product.id).all():
            key = product_dedupe_key(product.name)
            if key and key not in canonical:
                canonical[key] = product
        return canonical

    def _resolve_canonical_product(self, db: Session, product_id: int) -> Product:
        from modules.product_catalog import product_dedupe_key

        product = db.get(Product, product_id)
        if not product:
            raise ValueError(f"Product not found: {product_id}")
        key = product_dedupe_key(product.name)
        canonical = self._canonical_product_by_key(db).get(key)
        return canonical or product

    def _line_payload(

        self, db: Session, line: QuotationLineItem, buyer_id: int

    ) -> dict:

        product = db.get(Product, line.product_id)

        packaging = (product.spec_sheet or {}).get("packaging") if product else None

        dims = lookup_for_product(product.name, packaging) if product else None

        qty = float(line.quantity)

        price = float(line.unit_price)

        return {

            "product_id": line.product_id,

            "product_name": product.name if product else None,

            "quantity": qty,

            "unit_price": price,

            "price_unit": price_unit_for_category(product.category if product else None),

            "line_total": qty * price,

            "carton_dimensions": dims,

        }



    def create_quotation(

        self,

        db: Session,

        *,

        buyer_id: int,

        lines: list[dict],

        incoterms: str = "FOB",

        validity_days: int = 14,

    ) -> Quotation:

        if not lines:

            raise ValueError("At least one product line is required")



        buyer = db.get(Buyer, buyer_id)

        if not buyer:

            raise ValueError("Buyer not found")

        seen_keys: set[str] = set()
        from modules.product_catalog import product_dedupe_key

        normalized_lines: list[dict] = []
        for spec in lines:
            product = self._resolve_canonical_product(db, spec["product_id"])
            key = product_dedupe_key(product.name)
            if key in seen_keys:
                raise ValueError("Each product can only appear once in a quotation")
            seen_keys.add(key)
            normalized_lines.append({**spec, "product_id": product.id})

        validity = date.today() + timedelta(days=validity_days)

        quotation = Quotation(

            buyer_id=buyer_id,

            incoterms=incoterms,

            validity_date=validity,

            status=QuotationStatus.draft,

        )

        db.add(quotation)

        db.flush()



        resolved_lines: list[QuotationLineItem] = []

        for idx, spec in enumerate(normalized_lines):

            product = db.get(Product, spec["product_id"])

            if not product:

                raise ValueError(f"Product not found: {spec['product_id']}")

            tier = spec.get("price_tier", "standard")

            unit_price = self.resolve_unit_price(product, buyer_id, db, tier)

            line = QuotationLineItem(

                quotation_id=quotation.id,

                product_id=product.id,

                quantity=spec["quantity"],

                unit_price=unit_price,

                sort_order=idx,

            )

            db.add(line)

            resolved_lines.append(line)



        first = resolved_lines[0]

        quotation.product_id = first.product_id

        quotation.quantity = first.quantity

        quotation.unit_price = first.unit_price



        db.commit()

        db.refresh(quotation)



        pdf_path = self.generate_quotation_pdf(db, quotation.id)

        quotation.pdf_path = str(pdf_path)

        db.commit()

        db.refresh(quotation)

        return quotation



    def generate_quotation_pdf(self, db: Session, quotation_id: int) -> Path:

        quotation = db.get(Quotation, quotation_id)

        if not quotation:

            raise ValueError("Quotation not found")



        buyer = db.get(Buyer, quotation.buyer_id)

        line_payloads = [self._line_payload(db, line, quotation.buyer_id) for line in quotation.line_items]

        if not line_payloads and quotation.product_id:

            product = db.get(Product, quotation.product_id)

            line_payloads = [

                {

                    "product_name": product.name if product else "N/A",

                    "quantity": float(quotation.quantity or 0),

                    "unit_price": float(quotation.unit_price or 0),

                    "price_unit": price_unit_for_category(product.category if product else None),

                    "line_total": float(quotation.quantity or 0) * float(quotation.unit_price or 0),

                    "carton_dimensions": lookup_for_product(

                        product.name if product else "",

                        (product.spec_sheet or {}).get("packaging") if product else None,

                    ),

                }

            ]



        rows_html = ""

        grand_total = 0.0

        for row in line_payloads:

            grand_total += row["line_total"]

            dims = row.get("carton_dimensions") or {}

            dim_note = ""

            if dims.get("length_cm") and dims.get("width_cm") and dims.get("height_cm"):

                dim_note = (

                    f"<br><small>Carton: {dims['length_cm']}×{dims['width_cm']}×{dims['height_cm']} cm"

                )

                if dims.get("cbm"):

                    dim_note += f" · CBM {dims['cbm']}"

                dim_note += "</small>"

            rows_html += f"""

            <tr>

              <td>{row['product_name']}{dim_note}</td>

              <td>{row['quantity']}</td>

              <td>{row['unit_price']} ({row['price_unit']})</td>

              <td>{row['line_total']:,.2f}</td>

            </tr>"""



        html = f"""

        <!DOCTYPE html>

        <html><head><meta charset="utf-8"><title>Quotation</title></head>

        <body style="font-family: Arial, sans-serif; padding: 40px;">

          <h1>Kafi Commodities</h1>

          <h2>Quotation #{quotation.id}</h2>

          <p><strong>Buyer:</strong> {buyer.company_name if buyer else 'N/A'}</p>

          <p><strong>Incoterms:</strong> {quotation.incoterms or 'FOB'}</p>

          <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">

            <tr><th>Product</th><th>Qty</th><th>Unit Price</th><th>Total (USD)</th></tr>

            {rows_html}

            <tr>

              <td colspan="3" style="text-align: right;"><strong>Grand total</strong></td>

              <td><strong>{grand_total:,.2f}</strong></td>

            </tr>

          </table>

          <p><strong>Validity:</strong> {quotation.validity_date}</p>

          <p style="margin-top: 24px; color: #555;">Draft quotation — subject to approval.</p>

        </body></html>

        """



        output = self.storage_dir / f"quotation_{quotation_id}.pdf"

        try:

            from weasyprint import HTML



            HTML(string=html).write_pdf(output)

        except Exception:

            output = self.storage_dir / f"quotation_{quotation_id}.html"

            output.write_text(html, encoding="utf-8")



        return output



    def recommend_upsell(self, db: Session, buyer_id: int) -> list[dict[str, str]]:

        history = (

            db.query(ExportHistory)

            .filter(ExportHistory.buyer_id == buyer_id)

            .all()

        )

        if not history:

            return []



        purchased_ids = {h.product_id for h in history}

        products = db.query(Product).filter(Product.id.notin_(purchased_ids)).limit(3).all()

        recommendations = []

        for p in products:

            rationale = f"Complements existing purchases; {p.category or 'related'} category."

            recommendations.append(

                {"product_id": str(p.id), "product_name": p.name, "rationale": rationale}

            )

        return recommendations



    def recommend_cross_sell_from_catalog(

        self, db: Session, buyer_id: int, *, limit: int = 5

    ) -> list[dict[str, str]]:

        """Cross-sell complementary ESSENCE lines based on this buyer's fit and order history."""

        buyer = db.get(Buyer, buyer_id)
        if not buyer:
            raise ValueError("Buyer not found")

        history = (

            db.query(ExportHistory)

            .join(Product, ExportHistory.product_id == Product.id)

            .filter(ExportHistory.buyer_id == buyer_id)

            .all()

        )

        purchased_categories = [h.product.category for h in history if h.product and h.product.category]

        profile = ResearchModule().get_saved_profile(db, buyer_id)
        matched_categories: list[str] = []
        matched_products: list[dict] = []
        buyer_context = " ".join(
            filter(
                None,
                [
                    buyer.company_name,
                    buyer.industry or "",
                    profile.website_summary if profile else "",
                ],
            )
        )

        if profile:
            matched_categories = list(profile.matched_categories or [])
            matched_products = list(profile.matched_products or [])
            if profile.relationship_context:
                buyer_context = f"{buyer_context} {profile.relationship_context}"

        return recommend_cross_sell_for_buyer(
            matched_categories=matched_categories,
            matched_products=matched_products,
            purchased_categories=purchased_categories,
            buyer_context=buyer_context,
            limit=limit,
        )



    def list_quotations(self, db: Session, *, buyer_id: int | None = None) -> list[Quotation]:

        query = db.query(Quotation).order_by(Quotation.generated_at.desc())

        if buyer_id is not None:

            query = query.filter(Quotation.buyer_id == buyer_id)

        return query.all()



    def get_or_create_db_product(self, db: Session, *, name: str, category: str) -> Product:

        existing = db.query(Product).filter(Product.name == name).first()

        if existing:

            return existing



        catalog_item = next(

            (p for p in load_catalog().get("products", []) if p.get("name") == name),

            None,

        )

        product = Product(

            name=name,

            category=category,

            spec_sheet={

                "brand": (catalog_item or {}).get("brand", "ESSENCE"),

                "packaging": (catalog_item or {}).get("packaging"),

            },

            price_tiers=price_tiers_for_category(category),

            moq="1 carton",

            certifications={"halal": True},

        )

        db.add(product)

        db.commit()

        db.refresh(product)

        return product



    def create_quotations_for_scored_lead(

        self,

        db: Session,

        buyer_id: int,

        *,

        quantity: float = 20.0,

        incoterms: str = "FOB",

        max_quotes: int = 3,

    ) -> list[Quotation]:

        """Create one draft quotation with multiple product lines for AAA/AA graded companies."""

        from modules.leads import get_latest_score



        score_record = get_latest_score(db, buyer_id)

        if not score_record:

            raise ValueError("Lead must be scored before creating quotations")

        if score_record.score not in (LeadScoreLabel.AAAA, LeadScoreLabel.AAA, LeadScoreLabel.AA):

            raise ValueError("Quotations are only auto-created for AAAA, AAA, or AA graded companies")



        profile = ResearchModule().research_buyer(db, buyer_id)

        candidates: list[dict[str, str]] = list(profile.matched_products)



        if not candidates and profile.matched_categories:

            for cat in profile.matched_categories[:max_quotes]:

                cat_products = list_products(cat)

                if cat_products:

                    sample = cat_products[0]

                    candidates.append({"name": sample["name"], "category": sample["category"]})



        if not candidates:

            raise ValueError(

                "No product fit found for this lead. Run research first or create a quotation manually."

            )



        lines: list[dict] = []

        for item in candidates[:max_quotes]:

            product = self.get_or_create_db_product(

                db, name=item["name"], category=item["category"]

            )

            lines.append({"product_id": product.id, "quantity": quantity, "price_tier": "standard"})



        return [

            self.create_quotation(

                db,

                buyer_id=buyer_id,

                lines=lines,

                incoterms=incoterms,

            )

        ]



    def sync_catalog_to_products(self, db: Session) -> dict[str, int]:

        """Import ESSENCE catalog JSON into the products table (idempotent by name)."""

        catalog_products = load_catalog().get("products", [])

        created = 0

        skipped = 0

        from modules.product_catalog import product_dedupe_key

        existing_keys = {
            product_dedupe_key(p.name) for p in db.query(Product).all()
        }

        for item in catalog_products:

            key = product_dedupe_key(item["name"])

            if key in existing_keys:

                skipped += 1

                continue

            db.add(

                Product(

                    name=item["name"],

                    category=item.get("category"),

                    spec_sheet={

                        "brand": item.get("brand", "ESSENCE"),

                        "packaging": item.get("packaging"),

                        "catalog_id": item.get("id"),

                    },

                    price_tiers=price_tiers_for_category(item.get("category")),

                    moq="1 carton",

                    certifications={"halal": True},

                )

            )

            created += 1

            existing_keys.add(key)

        if created:

            db.commit()

        return {

            "created": created,

            "skipped": skipped,

            "total": db.query(Product).count(),

        }



    def list_products(self, db: Session) -> list[Product]:

        if db.query(Product).count() < 10:

            self.sync_catalog_to_products(db)

        products = db.query(Product).order_by(Product.category, Product.name).all()

        updated = False

        for product in products:

            if not product.price_tiers or product.price_tiers.get("standard") == 500:

                product.price_tiers = price_tiers_for_category(product.category)

                updated = True

        if updated:

            db.commit()

        return self._unique_products(products)



    def quotation_to_dict(self, db: Session, quotation: Quotation) -> dict:

        buyer = db.get(Buyer, quotation.buyer_id)

        line_payloads = [

            {

                "product_id": row["product_id"],

                "product_name": row["product_name"],

                "quantity": row["quantity"],

                "unit_price": row["unit_price"],

                "price_unit": row["price_unit"],

                "line_total": row["line_total"],

            }

            for row in (

                self._line_payload(db, line, quotation.buyer_id) for line in quotation.line_items

            )

        ]



        if not line_payloads and quotation.product_id:

            product = db.get(Product, quotation.product_id)

            qty = float(quotation.quantity or 0)

            price = float(quotation.unit_price or 0)

            line_payloads = [

                {

                    "product_id": quotation.product_id,

                    "product_name": product.name if product else None,

                    "quantity": qty,

                    "unit_price": price,

                    "price_unit": price_unit_for_category(product.category if product else None),

                    "line_total": qty * price,

                }

            ]



        grand_total = sum(row["line_total"] for row in line_payloads)

        first = line_payloads[0] if line_payloads else None



        return {

            "id": quotation.id,

            "buyer_id": quotation.buyer_id,

            "product_id": first["product_id"] if first else quotation.product_id,

            "quantity": first["quantity"] if first else quotation.quantity,

            "unit_price": first["unit_price"] if first else quotation.unit_price,

            "incoterms": quotation.incoterms,

            "validity_date": quotation.validity_date,

            "status": quotation.status.value if quotation.status else "draft",

            "pdf_path": quotation.pdf_path,

            "buyer_name": buyer.company_name if buyer else None,

            "product_name": (

                first["product_name"]

                if len(line_payloads) == 1

                else f"{len(line_payloads)} products"

                if line_payloads

                else None

            ),

            "price_unit": first["price_unit"] if first else None,

            "line_total": first["line_total"] if len(line_payloads) == 1 else grand_total,

            "lines": line_payloads,

            "grand_total": grand_total,

        }



    def approve_quotation(self, db: Session, quotation_id: int) -> Quotation:

        quotation = db.get(Quotation, quotation_id)

        if not quotation:

            raise ValueError("Quotation not found")

        quotation.status = QuotationStatus.approved

        db.commit()

        db.refresh(quotation)

        return quotation



    def create_quotation_email_draft(self, db: Session, quotation_id: int):

        from modules import buyers as buyers_module

        from modules.comms_generator import get_comms



        quotation = db.get(Quotation, quotation_id)

        if not quotation:

            raise ValueError("Quotation not found")

        if quotation.status not in (QuotationStatus.draft, QuotationStatus.approved):

            raise ValueError("Quotation cannot be emailed in its current status")



        buyer = db.get(Buyer, quotation.buyer_id)

        contact = buyers_module.primary_contact_with_email(db, quotation.buyer_id)

        if not contact:

            raise ValueError("Add a contact with an email address for this lead")



        payload = self.quotation_to_dict(db, quotation)

        lines = payload.get("lines") or []

        if len(lines) == 1:

            line = lines[0]

            draft = get_comms().generate_quotation_email(

                db,

                contact_id=contact.id,

                buyer_name=buyer.company_name if buyer else "your company",

                product_name=line["product_name"] or "Kafi ESSENCE product",

                quantity=line["quantity"],

                unit_price=line["unit_price"],

                unit_label=line["price_unit"] or "USD/carton",

                line_total=line["line_total"],

                incoterms=quotation.incoterms,

                validity_date=quotation.validity_date,

            )

        else:

            draft = get_comms().generate_quotation_email(

                db,

                contact_id=contact.id,

                buyer_name=buyer.company_name if buyer else "your company",

                product_name=f"{len(lines)} products",

                quantity=0,

                unit_price=0,

                unit_label="USD",

                line_total=payload["grand_total"] or 0,

                incoterms=quotation.incoterms,

                validity_date=quotation.validity_date,

                lines=lines,

            )

        quotation.status = QuotationStatus.approved

        db.commit()

        return draft



    def create_product(self, db: Session, data: dict) -> Product:

        product = Product(**data)

        db.add(product)

        db.commit()

        db.refresh(product)

        return product





_commerce = CommerceModule()





def get_commerce() -> CommerceModule:

    return _commerce


