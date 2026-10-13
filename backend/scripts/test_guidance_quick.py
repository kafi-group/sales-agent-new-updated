import os
import sys
import time
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))
os.chdir(_BACKEND)

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from db.models import AppUser, AppUserRole
from modules.helpful_guidance import generate_helpful_guidance

url = os.environ.get("DATABASE_URL", "")
if "pooler.supabase.com:5432" in url:
    url = url.replace(":5432/", ":6543/")
print("DB url set:", bool(url), flush=True)
engine = create_engine(url, poolclass=NullPool)
Session = sessionmaker(bind=engine)
with Session() as db:
    admin = (
        db.query(AppUser)
        .filter(AppUser.role == AppUserRole.admin, AppUser.is_active.is_(True))
        .first()
    )
    print("Admin:", admin.username if admin else None, flush=True)
    t0 = time.time()
    result = generate_helpful_guidance(db, viewer=admin, months=3, user_id=None)
    print("OK in", round(time.time() - t0, 2), "s", flush=True)
    print("scanned_remarks:", result["remark_patterns"]["scanned_remarks"], flush=True)
