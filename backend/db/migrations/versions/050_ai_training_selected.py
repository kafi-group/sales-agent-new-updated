"""NO-OP: Train Sara & Rayan flag uses attachments JSON — never ALTER interactions.

Revision ID: 050_ai_training_selected
Revises: 049_personal_whatsapp_user

Earlier drafts of this migration ADDed a boolean column / index on interactions,
which locked the busy table and took Railway offline (502). The flag is stored as
{"type": "ai_training", "selected": true} inside interactions.attachments instead.
This revision only stamps forward so deploys stay green.
"""

from typing import Union

revision: str = "050_ai_training_selected"
down_revision: Union[str, None] = "049_personal_whatsapp_user"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Intentionally empty — do not ALTER interactions.
    return


def downgrade() -> None:
    return
