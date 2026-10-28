"""Shared memory hygiene for the auction + map-features rebuilds.

Both rebuilds briefly allocate large in-memory artifacts (the auction rebuild
builds the full listings/summary graph in-process; the map-features rebuild
merges large per-category documents). On the 1GB production container their
peaks must not overlap, or the combined RSS trips the cgroup OOM-killer — so a
single process-wide lock serializes their heavy sections. ``reclaim()``
additionally hands freed heap back to the OS (glibc otherwise keeps it in-arena
and RSS only ratchets up).
"""

from __future__ import annotations

import ctypes
import ctypes.util
import gc
import threading
from typing import Any

# Serializes the heavy section of either rebuild. Both run in executor threads,
# so a threading.Lock — not asyncio.Lock — is the correct primitive.
REBUILD_MEMORY_LOCK = threading.Lock()

# glibc malloc_trim(0): return freed heap to the OS. None=untried,
# False=unavailable (e.g. musl / non-glibc), else the resolved callable.
_libc_malloc_trim: Any = None


def _malloc_trim() -> None:
    global _libc_malloc_trim
    if _libc_malloc_trim is None:
        try:
            libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
            _libc_malloc_trim = getattr(libc, "malloc_trim", False)
        except Exception:
            _libc_malloc_trim = False
    if _libc_malloc_trim:
        try:
            _libc_malloc_trim(0)
        except Exception:
            pass


def reclaim() -> None:
    """Collect cyclic garbage and return the freed heap to the OS."""
    gc.collect()
    _malloc_trim()
