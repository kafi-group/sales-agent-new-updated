"""Sandbox test accounts: admin screens, private empty data.

Haris (and any future is_sandbox admin) can use the same features as Khalid
except user management. Reads and writes stay on rows he owns. The live team
never sees those rows, and he never sees theirs.
"""

from __future__ import annotations

from sqlalchemy import or_
from sqlalchemy.orm import Session

from db.models import AppUser, AppUserRole

SANDBOX_USERNAME = "haris"
SANDBOX_PASSWORD = "1234"
SANDBOX_FULL_NAME = "Haris"


def is_sandbox_user(user: AppUser | None) -> bool:
    return bool(user is not None and getattr(user, "is_sandbox", False))


def role_value(user: AppUser) -> str:
    role = user.role
    return role.value if isinstance(role, AppUserRole) else str(role)


def is_feature_admin(user: AppUser | None) -> bool:
    if user is None:
        return False
    return role_value(user) == AppUserRole.admin.value


def is_real_admin(user: AppUser | None) -> bool:
    """Company admin. Sandbox admins are excluded."""
    return is_feature_admin(user) and not is_sandbox_user(user)


def owned_scope_user_id(user: AppUser) -> int | None:
    """None means company-wide data. Sandbox and sales users are limited to their id."""
    if is_real_admin(user):
        return None
    return int(user.id)


def sandbox_user_ids(db: Session) -> list[int]:
    cached = db.info.get("_sandbox_user_ids")
    if cached is not None:
        return cached
    rows = db.query(AppUser.id).filter(AppUser.is_sandbox.is_(True)).all()
    ids = [int(row[0]) for row in rows]
    db.info["_sandbox_user_ids"] = ids
    return ids


def exclude_sandbox_assignees(query, db: Session, column):
    """Drop rows owned by a sandbox user from a company-wide buyer query."""
    ids = sandbox_user_ids(db)
    if not ids:
        return query
    return query.filter(or_(column.is_(None), column.notin_(ids)))


def exclude_sandbox_actors(query, db: Session, column):
    """Drop events recorded by a sandbox user. NULL actors stay visible."""
    ids = sandbox_user_ids(db)
    if not ids:
        return query
    return query.filter(or_(column.is_(None), column.notin_(ids)))


def scope_owner_rows(query, db: Session, user: AppUser | None, owner_column):
    """Sandbox sees only rows they own. Live users never see sandbox-owned rows.

    NULL owner means a company row: visible to the live team, hidden from sandbox.
    """
    if user is not None and is_sandbox_user(user):
        return query.filter(owner_column == user.id)
    ids = sandbox_user_ids(db)
    if not ids:
        return query
    return query.filter(or_(owner_column.is_(None), owner_column.notin_(ids)))


def owner_clause(db: Session, user: AppUser | None, owner_column):
    """SQLAlchemy boolean clause matching scope_owner_rows, for select() queries."""
    if user is not None and is_sandbox_user(user):
        return owner_column == user.id
    ids = sandbox_user_ids(db)
    if not ids:
        return None
    return or_(owner_column.is_(None), owner_column.notin_(ids))


def owner_row_visible(db: Session, user: AppUser, owner_id: int | None) -> bool:
    if is_sandbox_user(user):
        return owner_id is not None and int(owner_id) == int(user.id)
    if owner_id is None:
        return True
    owner = db.get(AppUser, int(owner_id))
    return not is_sandbox_user(owner)


def buyer_visible_to(db: Session, user: AppUser, buyer) -> bool:
    if buyer is None:
        return False
    assignee = getattr(buyer, "assigned_to_user_id", None)
    if is_sandbox_user(user):
        return assignee is not None and int(assignee) == int(user.id)
    if assignee is not None:
        owner = db.get(AppUser, int(assignee))
        if is_sandbox_user(owner):
            return False
    return True
