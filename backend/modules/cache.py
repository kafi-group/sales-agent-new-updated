"""Lightweight in-memory TTL cache for hot read paths.

Single-process singleton — resets per Railway worker, which is fine for
TTL data (section counts, filter options, etc.).  Interface is intentionally
compatible with a future Redis drop-in: .get() / .set() / .delete() /
.clear_prefix() map 1-to-1 to redis-py equivalents.
"""

from __future__ import annotations

import threading
import time
from typing import Any

_MISS = object()


class _TTLCache:
    """Thread-safe in-memory key/value store with per-entry TTL."""

    def __init__(self) -> None:
        self._store: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Any:
        """Return the cached value, or the _MISS sentinel if absent/expired."""
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return _MISS
            expires_at, value = entry
            if time.monotonic() > expires_at:
                del self._store[key]
                return _MISS
            return value

    def set(self, key: str, value: Any, *, ttl: float) -> None:
        """Store value under key for ttl seconds."""
        with self._lock:
            self._store[key] = (time.monotonic() + ttl, value)

    def delete(self, key: str) -> None:
        """Remove a single key (no-op if absent)."""
        with self._lock:
            self._store.pop(key, None)

    def clear_prefix(self, prefix: str) -> None:
        """Remove all keys that start with prefix."""
        with self._lock:
            drop = [k for k in self._store if k.startswith(prefix)]
            for k in drop:
                del self._store[k]

    def clear(self) -> None:
        """Flush the entire cache."""
        with self._lock:
            self._store.clear()

    def evict_expired(self) -> int:
        """Remove expired entries; returns the number evicted."""
        now = time.monotonic()
        with self._lock:
            drop = [k for k, (exp, _) in self._store.items() if now > exp]
            for k in drop:
                del self._store[k]
        return len(drop)


# Module-level singleton used by all hot paths.
cache = _TTLCache()

# Re-export sentinel so callers can check: `if result is MISS: ...`
MISS = _MISS
