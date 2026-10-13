from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from config import settings


def _engine_url(url: str) -> str:
    """Force psycopg2 so a accidental SQLAlchemy 2.1 bump cannot require psycopg v3."""
    if url.startswith("postgresql://"):
        return "postgresql+psycopg2://" + url[len("postgresql://") :]
    if url.startswith("postgres://"):
        return "postgresql+psycopg2://" + url[len("postgres://") :]
    return url


# Keep pools modest per worker. Oversized pools exhaust Supabase limits and
# hang the app → Railway 502. Tune via DB_POOL_SIZE / DB_MAX_OVERFLOW.
# LIFO reuses hot connections under bursty CRM polling.
_db_url = _engine_url(settings.database_url)
connect_args: dict = {}
if not _db_url.startswith("sqlite"):
    connect_args = {
        "keepalives": 1,
        "keepalives_idle": 20,
        "keepalives_interval": 10,
        "keepalives_count": 5,
    }

engine = create_engine(
    _db_url,
    pool_pre_ping=True,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_timeout=settings.db_pool_timeout,
    pool_recycle=60,
    pool_use_lifo=True,
    connect_args=connect_args,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
