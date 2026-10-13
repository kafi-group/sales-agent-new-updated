"""Migrate lead scores HOT/WARM/COLD → AAA/AA/A company grades

Revision ID: 026_score_to_company_grade
Revises: 025_email_activity_user_id
Create Date: 2026-07-24
"""

from typing import Sequence, Union

from alembic import op

revision: str = "026_score_to_company_grade"
down_revision: Union[str, None] = "025_email_activity_user_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Rebuild Postgres enum leadscorelabel: HOT/WARM/COLD → AAA/AA/A
    op.execute("ALTER TYPE leadscorelabel RENAME TO leadscorelabel_old")
    op.execute("CREATE TYPE leadscorelabel AS ENUM ('AAA', 'AA', 'A')")
    op.execute(
        """
        ALTER TABLE lead_scores
        ALTER COLUMN score TYPE leadscorelabel
        USING (
            CASE score::text
                WHEN 'HOT' THEN 'AAA'
                WHEN 'WARM' THEN 'AA'
                WHEN 'COLD' THEN 'A'
                WHEN 'AAA' THEN 'AAA'
                WHEN 'AA' THEN 'AA'
                WHEN 'A' THEN 'A'
                ELSE 'A'
            END
        )::leadscorelabel
        """
    )
    op.execute("DROP TYPE leadscorelabel_old")

    # Sync buyer.company_grading from latest score when missing or still HOT/WARM/COLD text
    op.execute(
        """
        UPDATE buyers AS b
        SET company_grading = mapped.grade
        FROM (
            SELECT DISTINCT ON (buyer_id)
                buyer_id,
                score::text AS grade
            FROM lead_scores
            ORDER BY buyer_id, scored_at DESC
        ) AS mapped
        WHERE b.id = mapped.buyer_id
          AND (
            b.company_grading IS NULL
            OR btrim(b.company_grading) = ''
            OR lower(btrim(b.company_grading)) IN ('hot', 'warm', 'cold')
          )
        """
    )

    # Normalize any remaining literal HOT/WARM/COLD stored as grading text
    op.execute(
        """
        UPDATE buyers
        SET company_grading = CASE lower(btrim(company_grading))
            WHEN 'hot' THEN 'AAA'
            WHEN 'warm' THEN 'AA'
            WHEN 'cold' THEN 'A'
            ELSE company_grading
        END
        WHERE company_grading IS NOT NULL
          AND lower(btrim(company_grading)) IN ('hot', 'warm', 'cold')
        """
    )


def downgrade() -> None:
    op.execute("ALTER TYPE leadscorelabel RENAME TO leadscorelabel_old")
    op.execute("CREATE TYPE leadscorelabel AS ENUM ('HOT', 'WARM', 'COLD')")
    op.execute(
        """
        ALTER TABLE lead_scores
        ALTER COLUMN score TYPE leadscorelabel
        USING (
            CASE score::text
                WHEN 'AAA' THEN 'HOT'
                WHEN 'AA' THEN 'WARM'
                WHEN 'A' THEN 'COLD'
                WHEN 'HOT' THEN 'HOT'
                WHEN 'WARM' THEN 'WARM'
                WHEN 'COLD' THEN 'COLD'
                ELSE 'COLD'
            END
        )::leadscorelabel
        """
    )
    op.execute("DROP TYPE leadscorelabel_old")
