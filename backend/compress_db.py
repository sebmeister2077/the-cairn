"""Benchmark compression / decompression of a large file with zstd and xz.

Usage examples (run from the repo root or anywhere — paths are resolved
relative to the current working directory):

    # Compress globalservermap.db with zstd level 10 (default), 4 threads
    python backend/compress_db.py compress --algo zstd backend/globalservermap.db

    # Same but xz / LZMA preset 6
    python backend/compress_db.py compress --algo xz backend/globalservermap.db

    # Decompress back to a sibling .out file (won't overwrite the original)
    python backend/compress_db.py decompress --algo zstd backend/globalservermap.db.zst

Notes
-----
* Streams in fixed-size chunks so peak RAM stays bounded regardless of
  input size (an 11 GB file is processed with ~MBs of working memory,
  not GBs).
* Reports wall-clock time, throughput, and **peak RSS delta** measured via
  ``resource.getrusage`` on POSIX or ``psutil``/``ctypes`` on Windows.
* For compression the resulting ratio + on-disk size is also printed.

zstd with threads=N will allocate ~`N × window_size` of working memory; at level 10 that's roughly N × 8 MiB, so still tiny.
xz at preset 6 uses ~94 MB compressing / ~9 MB decompressing per the LZMA spec.

This script has no side effects on the running backend; it only reads /
writes plain files. Safe to run while the server is up, though it will
contend for disk and CPU.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from typing import Callable, Optional, Tuple

# Stream chunk size. 4 MiB is a good trade-off: large enough to amortise
# Python overhead per call, small enough that peak RSS stays tiny.
CHUNK_SIZE = 4 * 1024 * 1024


# ---------------------------------------------------------------------------
# Memory sampling helpers
# ---------------------------------------------------------------------------

def _peak_rss_bytes() -> int:
    """Return current process peak RSS in bytes, or 0 if we can't tell."""
    # Prefer psutil if available — works cross-platform and gives current
    # peak via memory_info().peak_wset on Windows.
    try:
        import psutil  # type: ignore
        p = psutil.Process(os.getpid())
        info = p.memory_info()
        # peak_wset only exists on Windows; fall back to rss otherwise.
        return int(getattr(info, "peak_wset", info.rss))
    except ImportError:
        pass

    # POSIX path: ru_maxrss is in KiB on Linux, bytes on macOS.
    try:
        import resource  # type: ignore
        ru = resource.getrusage(resource.RUSAGE_SELF)
        if sys.platform == "darwin":
            return int(ru.ru_maxrss)
        return int(ru.ru_maxrss) * 1024
    except ImportError:
        pass

    # Windows without psutil: query PROCESS_MEMORY_COUNTERS via ctypes.
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            class _PMC(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            counters = _PMC()
            counters.cb = ctypes.sizeof(_PMC)
            handle = ctypes.windll.kernel32.GetCurrentProcess()
            ok = ctypes.windll.psapi.GetProcessMemoryInfo(
                handle, ctypes.byref(counters), counters.cb
            )
            if ok:
                return int(counters.PeakWorkingSetSize)
        except Exception:
            pass

    return 0


def _format_bytes(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(n) < 1024:
            return f"{n:,.2f} {unit}"
        n /= 1024
    return f"{n:,.2f} PiB"


# ---------------------------------------------------------------------------
# Streaming runner
# ---------------------------------------------------------------------------

def _run_stream(
    src_path: Path,
    dst_path: Path,
    transform: Callable[[bytes], bytes],
    flush: Callable[[], bytes],
    label: str,
) -> Tuple[int, int, float, int]:
    """Stream ``src_path`` through ``transform`` chunks into ``dst_path``.

    ``transform(chunk)`` is called for each input chunk and must return the
    compressed/decompressed bytes (may be empty). ``flush()`` is called once
    at EOF and must return any final buffered bytes.

    Returns ``(input_bytes, output_bytes, elapsed_seconds, peak_rss_bytes)``.
    """
    src_size = src_path.stat().st_size
    print(
        f"[{label}] {src_path}  ({_format_bytes(src_size)})  ->  {dst_path}",
        flush=True,
    )

    in_bytes = 0
    out_bytes = 0
    last_log = time.monotonic()
    rss_baseline = _peak_rss_bytes()
    t0 = time.monotonic()

    with open(src_path, "rb") as fin, open(dst_path, "wb") as fout:
        while True:
            chunk = fin.read(CHUNK_SIZE)
            if not chunk:
                break
            in_bytes += len(chunk)
            piece = transform(chunk)
            if piece:
                fout.write(piece)
                out_bytes += len(piece)
            now = time.monotonic()
            if now - last_log >= 2.0:
                pct = (in_bytes / src_size * 100) if src_size else 100.0
                rate = in_bytes / max(now - t0, 1e-9)
                print(
                    f"  ... {pct:5.1f}%  "
                    f"in={_format_bytes(in_bytes)}  "
                    f"out={_format_bytes(out_bytes)}  "
                    f"rate={_format_bytes(rate)}/s",
                    flush=True,
                )
                last_log = now
        tail = flush()
        if tail:
            fout.write(tail)
            out_bytes += len(tail)

    elapsed = time.monotonic() - t0
    rss_peak = _peak_rss_bytes()
    rss_delta = max(rss_peak - rss_baseline, 0)
    return in_bytes, out_bytes, elapsed, rss_delta


# ---------------------------------------------------------------------------
# zstd backend
# ---------------------------------------------------------------------------

def _zstd_compressor(level: int, threads: int):
    try:
        import zstandard as zstd  # type: ignore
    except ImportError as e:
        raise SystemExit(
            "zstandard package not installed. Run: pip install zstandard"
        ) from e
    cctx = zstd.ZstdCompressor(level=level, threads=threads)
    chunker = cctx.chunker(chunk_size=CHUNK_SIZE)

    def transform(buf: bytes) -> bytes:
        return b"".join(chunker.compress(buf))

    def flush() -> bytes:
        return b"".join(chunker.finish())

    return transform, flush


def _zstd_decompressor():
    try:
        import zstandard as zstd  # type: ignore
    except ImportError as e:
        raise SystemExit(
            "zstandard package not installed. Run: pip install zstandard"
        ) from e
    dctx = zstd.ZstdDecompressor()
    dobj = dctx.decompressobj()

    def transform(buf: bytes) -> bytes:
        return dobj.decompress(buf)

    def flush() -> bytes:
        # zstandard's decompressobj has no explicit flush; any unused_data
        # would indicate trailing junk and is ignored here.
        return b""

    return transform, flush


# ---------------------------------------------------------------------------
# xz / lzma backend (stdlib)
# ---------------------------------------------------------------------------

def _xz_compressor(preset: int):
    import lzma
    # FORMAT_XZ + LZMA2 with the requested preset. Single-threaded in stdlib.
    comp = lzma.LZMACompressor(
        format=lzma.FORMAT_XZ,
        check=lzma.CHECK_CRC64,
        preset=preset,
    )

    def transform(buf: bytes) -> bytes:
        return comp.compress(buf)

    def flush() -> bytes:
        return comp.flush()

    return transform, flush


def _xz_decompressor():
    import lzma
    decomp = lzma.LZMADecompressor(format=lzma.FORMAT_XZ)

    def transform(buf: bytes) -> bytes:
        return decomp.decompress(buf)

    def flush() -> bytes:
        return b""

    return transform, flush


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

EXT = {"zstd": ".zst", "xz": ".xz"}


def _default_dst(src: Path, mode: str, algo: str, override: Optional[Path]) -> Path:
    if override is not None:
        return override
    if mode == "compress":
        return src.with_name(src.name + EXT[algo])
    # decompress: strip known extension if present, else append ".out".
    suffix = src.suffix.lower()
    if suffix in (".zst", ".xz"):
        return src.with_suffix("")
    return src.with_name(src.name + ".out")


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument(
        "mode",
        choices=("compress", "decompress"),
        help="Operation to perform.",
    )
    p.add_argument(
        "input",
        type=Path,
        help="Path to the source file.",
    )
    p.add_argument(
        "--algo",
        choices=("zstd", "xz"),
        required=True,
        help="Compression algorithm to use.",
    )
    p.add_argument(
        "--level",
        type=int,
        default=None,
        help=(
            "Compression level. zstd: 1-22 (default 10). "
            "xz/lzma: 0-9 (default 6). Ignored for decompression."
        ),
    )
    p.add_argument(
        "--threads",
        type=int,
        default=max(1, (os.cpu_count() or 2) - 1),
        help="zstd worker threads (default: CPU count - 1). Ignored for xz.",
    )
    p.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Destination file (defaults to input + .zst/.xz, or stripped).",
    )
    p.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite the destination file if it already exists.",
    )
    return p


def main(argv: Optional[list] = None) -> int:
    args = _build_parser().parse_args(argv)
    src: Path = args.input
    if not src.is_file():
        print(f"error: input not found or not a file: {src}", file=sys.stderr)
        return 2

    dst = _default_dst(src, args.mode, args.algo, args.output)
    if dst.exists() and not args.overwrite:
        print(
            f"error: destination already exists: {dst}\n"
            f"       pass --overwrite to replace it.",
            file=sys.stderr,
        )
        return 2

    if args.mode == "compress":
        if args.algo == "zstd":
            level = args.level if args.level is not None else 10
            transform, flush = _zstd_compressor(level=level, threads=args.threads)
            label = f"zstd-c L{level} T{args.threads}"
        else:
            preset = args.level if args.level is not None else 6
            if not 0 <= preset <= 9:
                print("error: xz preset must be 0-9", file=sys.stderr)
                return 2
            transform, flush = _xz_compressor(preset=preset)
            label = f"xz-c P{preset}"
    else:
        if args.algo == "zstd":
            transform, flush = _zstd_decompressor()
            label = "zstd-d"
        else:
            transform, flush = _xz_decompressor()
            label = "xz-d"

    try:
        in_bytes, out_bytes, elapsed, rss_delta = _run_stream(
            src, dst, transform, flush, label,
        )
    except KeyboardInterrupt:
        print("\ninterrupted; partial output left at", dst, file=sys.stderr)
        return 130

    rate_in = in_bytes / max(elapsed, 1e-9)
    rate_out = out_bytes / max(elapsed, 1e-9)
    print()
    print(f"=== {label} done ===")
    print(f"  input         : {_format_bytes(in_bytes)}")
    print(f"  output        : {_format_bytes(out_bytes)}")
    if args.mode == "compress" and in_bytes > 0:
        ratio = out_bytes / in_bytes
        saved = 1.0 - ratio
        print(f"  ratio         : {ratio*100:.2f}% of original  ({saved*100:.2f}% saved)")
    print(f"  elapsed       : {elapsed:.2f} s")
    print(f"  read rate     : {_format_bytes(rate_in)}/s")
    print(f"  write rate    : {_format_bytes(rate_out)}/s")
    if rss_delta:
        print(f"  peak RSS Δ    : {_format_bytes(rss_delta)}")
    else:
        print("  peak RSS Δ    : (unavailable — install psutil for accurate numbers)")
    print(f"  destination   : {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
