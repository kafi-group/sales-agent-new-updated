"""Store lead_scores.score as VARCHAR (not Postgres ENUM)

Revision ID: 027_lead_score_varchar
Revises: 026_score_to_company_grade
Create Date: 2026-07-24

Avoids brittle Postgres ENUM mismatches when app and DB revise
HOT/WARM/COLD ↔ AAA/AA/A at different times.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "027_lead_score_varchar"
down_revision: Union[str, None] = "026_score_to_company_grade"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Convert enum → varchar in one step (maps any leftover HOT/WARM/COLD).
    op.execute(
        """
        ALTER TABLE lead_scores
        ALTER COLUMN score TYPE VARCHAR(10)
        USING (
            CASE score::text
                WHEN 'HOT' THEN 'AAA'
                WHEN 'WARM' THEN 'AA'
                WHEN 'COLD' THEN 'A'
                ELSE score::text
            END
        )
        """
    )
    op.execute("DROP TYPE IF EXISTS leadscorelabel")
    op.execute("DROP TYPE IF EXISTS leadscorelabel_old")


def downgrade() -> None:
    op.execute("CREATE TYPE leadscorelabel AS ENUM ('AAA', 'AA', 'A')")
    op.execute(
        """
        ALTER TABLE lead_scores
        ALTER COLUMN score TYPE leadscorelabel
        USING (
            CASE score
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
