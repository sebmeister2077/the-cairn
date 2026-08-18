"""N-way merge of per-contributor map-features documents.

Each source is a ``MapExportDocument`` (the combined export the proxy uploads):
``{generatedUtc, upstream, worldSpawn, translocators[], traders[], rapids[],
traderClaims[], playerClaims[]}``. The merge is a **union per category, keyed by
position/identity**, with **last-writer-wins** on conflict (the record from the
source with the newest ``generatedUtc`` wins) while preserving the **earliest
``firstSeenUtc``** across all sources.

The result is deterministic and order-independent: sources are sorted by
``(generatedUtc, source_id)`` and applied in ascending order, so the newest
observation of any given feature is the one that survives.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Tuple

# doc_key = key in the MapExportDocument; cat = the envelope/category + file
# discriminator the frontend loads (map-features.<cat>.json).
CATEGORIES: List[Tuple[str, str]] = [
    ("translocators", "translocators"),
    ("traders", "traders"),
    ("rapids", "rapids"),
    ("traderClaims", "traderclaims"),
    ("playerClaims", "playerclaims"),
]

FeatureKey = Tuple[Any, ...]


def _num(v: Any) -> Optional[float]:
    return v if isinstance(v, (int, float)) else None


def _pt_key(pt: Any) -> Optional[Tuple[int, int, int]]:
    if not isinstance(pt, dict):
        return None
    x, y, z = _num(pt.get("x")), _num(pt.get("y")), _num(pt.get("z"))
    if x is None or y is None or z is None:
        return None
    return (round(x), round(y), round(z))


def _abs_key(f: Dict[str, Any]) -> Optional[FeatureKey]:
    pk = _pt_key(f.get("abs"))
    return ("abs", *pk) if pk else None


def _trader_key(f: Dict[str, Any]) -> Optional[FeatureKey]:
    eid = f.get("entityId")
    if isinstance(eid, int) and eid != 0:
        return ("e", eid)
    return _abs_key(f)


def _trader_claim_key(f: Dict[str, Any]) -> Optional[FeatureKey]:
    eid = f.get("entityId")
    if isinstance(eid, int) and eid != 0:
        return ("e", eid)
    pk = _pt_key(f.get("center"))
    return ("c", *pk) if pk else None


def _player_claim_key(f: Dict[str, Any]) -> Optional[FeatureKey]:
    uid = f.get("playerUid")
    mn, mx = _pt_key(f.get("min")), _pt_key(f.get("max"))
    if not isinstance(uid, str) or not uid or mn is None or mx is None:
        return None
    return (uid, mn, mx)


_KEY_FNS: Dict[str, Callable[[Dict[str, Any]], Optional[FeatureKey]]] = {
    "translocators": _abs_key,
    "traders": _trader_key,
    "rapids": _abs_key,
    "traderClaims": _trader_claim_key,
    "playerClaims": _player_claim_key,
}


def _min_iso(a: Optional[str], b: Optional[str]) -> Optional[str]:
    if not a:
        return b
    if not b:
        return a
    return a if a <= b else b


def _source_sort_key(item: Tuple[str, Dict[str, Any]]) -> Tuple[str, str]:
    sid, doc = item
    return (str(doc.get("generatedUtc") or ""), sid)


def merge_documents(sources: List[Tuple[str, Dict[str, Any]]]) -> Dict[str, Any]:
    """Union-merge the given ``(source_id, MapExportDocument)`` pairs.

    Returns a ``MapExportDocument`` (without ``generatedUtc`` — the caller
    stamps that at publish time)."""
    ordered = sorted((s for s in sources if isinstance(s[1], dict)), key=_source_sort_key)

    # Per category: key -> winning feature, and key -> earliest firstSeenUtc.
    winners: Dict[str, Dict[FeatureKey, Dict[str, Any]]] = {k: {} for k, _ in CATEGORIES}
    earliest: Dict[str, Dict[FeatureKey, Optional[str]]] = {k: {} for k, _ in CATEGORIES}

    upstream: Optional[str] = None
    world_spawn: Optional[Dict[str, Any]] = None

    for _sid, doc in ordered:
        if doc.get("upstream"):
            upstream = doc.get("upstream")
        if isinstance(doc.get("worldSpawn"), dict):
            world_spawn = doc.get("worldSpawn")
        for doc_key, _cat in CATEGORIES:
            feats = doc.get(doc_key)
            if not isinstance(feats, list):
                continue
            key_fn = _KEY_FNS[doc_key]
            wmap, emap = winners[doc_key], earliest[doc_key]
            for f in feats:
                if not isinstance(f, dict):
                    continue
                k = key_fn(f)
                if k is None:
                    continue
                emap[k] = _min_iso(emap.get(k), f.get("firstSeenUtc"))
                wmap[k] = f  # ascending order => newest source wins

    out: Dict[str, Any] = {}
    if upstream:
        out["upstream"] = upstream
    if world_spawn is not None:
        out["worldSpawn"] = world_spawn
    for doc_key, _cat in CATEGORIES:
        feats: List[Dict[str, Any]] = []
        for k, f in winners[doc_key].items():
            fs = earliest[doc_key].get(k)
            if fs and "firstSeenUtc" in f:
                f = {**f, "firstSeenUtc": fs}
            feats.append(f)
        out[doc_key] = feats
    return out
