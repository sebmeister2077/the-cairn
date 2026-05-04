"""zstd compression helpers used by upload / backup / archive flows.

Wraps the ``zstandard`` package to provide:

* :func:`compress_file` — stream a local file through a zstd encoder.
* :func:`decompress_file` — reverse direction.
* :func:`is_zstd_file` — magic-byte sniff so readers can decide whether
  to decompress without trusting the filename.
* :func:`resolve_threads` — translate the ``"single" | "half" | "all"``
  preset stored in ``app_settings`` into a concrete worker count.
* :data:`CALIBRATION_PER_GIB` — small lookup of (compressed-bytes,
  compress-seconds, decompress-seconds) per GiB of input, fitted from
  ``backend/compress_db.py`` benchmark runs. Used by the admin "estimate"
  endpoint to predict cost before saving new settings.

Memory: compression uses chunked streaming so peak RSS stays bounded
(roughly ``threads × window_size``; ~8 MiB per thread at level 10).
"""

from __future__ import annotations

import os
import time
from typing import Dict, Optional

# 4 MiB matches ``backend/compress_db.py``: large enough to amortise
# Python overhead, small enough that peak RSS stays tiny.
CHUNK_SIZE = 4 * 1024 * 1024

# zstd magic number — first 4 bytes of every frame. See RFC 8478 §3.1.1.
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"

# Allowed thread presets (see ``app_settings.compression_settings``).
THREAD_PRESETS = ("single", "half", "all")

# Calibration table. Keys are zstd levels; values are dicts with the
# expected output-bytes and seconds per GiB of *input* on a reference
# machine (single thread). The estimate endpoint scales these by the
# current combined-DB size and divides timings by the resolved thread
# count for compression (decompression is single-threaded in zstd).
#
# Numbers are rough averages from ``backend/compress_db.py`` runs against
# a snapshot of ``globalservermap.db``. They are fitted manually rather
# than computed at runtime to avoid blocking the admin UI on a benchmark.
# Update via the same script if drift becomes large.
CALIBRATION_PER_GIB: Dict[int, Dict[str, float]] = {
    1:  {"ratio": 0.18, "compress_s": 6.0,   "decompress_s": 1.5},
    3:  {"ratio": 0.14, "compress_s": 9.0,   "decompress_s": 1.6},
    6:  {"ratio": 0.10, "compress_s": 18.0,  "decompress_s": 1.7},
    10: {"ratio": 0.075, "compress_s": 38.0, "decompress_s": 1.8},
    15: {"ratio": 0.060, "compress_s": 110.0, "decompress_s": 2.0},
    19: {"ratio": 0.052, "compress_s": 360.0, "decompress_s": 2.2},
    22: {"ratio": 0.048, "compress_s": 900.0, "decompress_s": 2.4},
}


def _zstd():
    """Lazy import so the module is cheap to import even if the optional
    ``zstandard`` package is missing (the feature flag is OFF by default)."""
    try:
        import zstandard  # type: ignore
        return zstandard
    except ImportError as e:
        raise RuntimeError(
            "zstandard package not installed. Add 'zstandard' to backend/requirements.txt."
        ) from e


def resolve_threads(preset: str) -> int:
    """Map a textual preset to a concrete thread count for the current host.

    ``"single"`` → 1, ``"half"`` → max(1, cpu//2), ``"all"`` → cpu.
    Unknown presets fall back to 1.
    """
    cpu = os.cpu_count() or 1
    if preset == "single":
        return 1
    if preset == "half":
        return max(1, cpu // 2)
    if preset == "all":
        return max(1, cpu)
    return 1


def is_zstd_file(path: str) -> bool:
    """Return True if ``path`` starts with the zstd frame magic."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(4)
    except OSError:
        return False
    return head == ZSTD_MAGIC


def compress_file(
    src_path: str,
    dst_path: str,
    *,
    level: int = 10,
    threads: int = 1,
) -> Dict[str, float]:
    """Stream-compress ``src_path`` to ``dst_path``.

    Returns a metrics dict::

        {
            "input_bytes": int,
            "output_bytes": int,
            "elapsed_seconds": float,
            "ratio": float,            # output / input, 0 when input is empty
        }

    Caller is responsible for fsync / atomic-rename if durability matters.
    """
    zstd = _zstd()
    cctx = zstd.ZstdCompressor(level=int(level), threads=int(threads))

    in_bytes = 0
    out_bytes = 0
    t0 = time.monotonic()
    with open(src_path, "rb") as fin, open(dst_path, "wb") as fout:
        # ``stream_writer`` handles framing + flush automatically when the
        # context manager exits.
        with cctx.stream_writer(fout, closefd=False) as writer:
            while True:
                chunk = fin.read(CHUNK_SIZE)
                if not chunk:
                    break
                in_bytes += len(chunk)
                writer.write(chunk)
        out_bytes = fout.tell()

    elapsed = time.monotonic() - t0
    return {
        "input_bytes": in_bytes,
        "output_bytes": out_bytes,
        "elapsed_seconds": elapsed,
        "ratio": (out_bytes / in_bytes) if in_bytes else 0.0,
    }


def decompress_file(src_path: str, dst_path: str) -> Dict[str, float]:
    """Stream-decompress ``src_path`` to ``dst_path``.

    Returns a metrics dict mirroring :func:`compress_file`.
    Raises ``RuntimeError`` if the input is not a valid zstd frame.
    """
    zstd = _zstd()
    dctx = zstd.ZstdDecompressor()

    in_bytes = 0
    out_bytes = 0
    t0 = time.monotonic()
    with open(src_path, "rb") as fin, open(dst_path, "wb") as fout:
        try:
            dctx.copy_stream(fin, fout, read_size=CHUNK_SIZE)
        except zstd.ZstdError as e:
            raise RuntimeError(f"zstd decompress failed for {src_path}: {e}") from e
        in_bytes = fin.tell()
        out_bytes = fout.tell()

    elapsed = time.monotonic() - t0
    return {
        "input_bytes": in_bytes,
        "output_bytes": out_bytes,
        "elapsed_seconds": elapsed,
        "ratio": (in_bytes / out_bytes) if out_bytes else 0.0,
    }


def estimate_cost(input_bytes: int, level: int, threads: int) -> Dict[str, float]:
    """Predict compression time/size for ``input_bytes`` at ``level`` and
    ``threads`` from :data:`CALIBRATION_PER_GIB`.

    Linearly interpolates between the two nearest calibrated levels and
    scales compression time by ``1/threads`` (zstd parallelism is roughly
    linear up to a few cores at high levels). Decompression is single
    threaded in the python bindings, so its prediction ignores ``threads``.

    Returns ``{ "estimated_compressed_bytes", "estimated_compress_seconds",
    "estimated_decompress_seconds", "ratio" }``.
    """
    threads = max(1, int(threads))
    level = max(1, min(22, int(level)))
    gib = max(input_bytes, 0) / (1024 ** 3)

    keys = sorted(CALIBRATION_PER_GIB.keys())
    if level <= keys[0]:
        a = b = CALIBRATION_PER_GIB[keys[0]]
        t = 0.0
    elif level >= keys[-1]:
        a = b = CALIBRATION_PER_GIB[keys[-1]]
        t = 0.0
    else:
        # Find bracketing pair.
        lo = max(k for k in keys if k <= level)
        hi = min(k for k in keys if k >= level)
        a = CALIBRATION_PER_GIB[lo]
        b = CALIBRATION_PER_GIB[hi]
        t = 0.0 if hi == lo else (level - lo) / (hi - lo)

    def _interp(key: str) -> float:
        return float(a[key]) + t * (float(b[key]) - float(a[key]))

    ratio = _interp("ratio")
    comp_s = _interp("compress_s") * gib / threads
    decomp_s = _interp("decompress_s") * gib

    return {
        "estimated_compressed_bytes": int(input_bytes * ratio),
        "estimated_compress_seconds": comp_s,
        "estimated_decompress_seconds": decomp_s,
        "ratio": ratio,
    }


# ---------------------------------------------------------------------------
# Settings shape (consumed by the admin endpoints + write-path callers)
# ---------------------------------------------------------------------------

DEFAULT_LEVEL = 10
DEFAULT_THREADS_PRESET = "half"


def normalise_settings(raw: Optional[dict]) -> Dict[str, object]:
    """Coerce a raw ``app_settings`` value into a validated settings dict.

    Missing / invalid fields fall back to :data:`DEFAULT_LEVEL` /
    :data:`DEFAULT_THREADS_PRESET`. Always returns a fresh dict.
    """
    raw = raw or {}
    try:
        level = int(raw.get("level", DEFAULT_LEVEL))
    except (TypeError, ValueError):
        level = DEFAULT_LEVEL
    level = max(1, min(22, level))

    preset = str(raw.get("threads_preset", DEFAULT_THREADS_PRESET))
    if preset not in THREAD_PRESETS:
        preset = DEFAULT_THREADS_PRESET

    return {"level": level, "threads_preset": preset}
