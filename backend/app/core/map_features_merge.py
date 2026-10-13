"""N-way merge of per-contributor map-features documents.

Each source is a ``MapExportDocument`` (the combined export the proxy uploads):
``{generatedUtc, upstream, worldSpawn, translocators[], traders[], rapids[],
traderClaims[], playerClaims[]}``. The merge is a **union per category, keyed by
position/identity**, with **last-writer-wins** on conflict (the record from the
source with the newest ``generatedUtc`` wins).

The result is deterministic and order-independent: sources are sorted by
``(generatedUtc, source_id)`` and applied in ascending order, so the newest
observation of any given feature is the one that survives.

**Player claims are special-cased.** A player's land claims change over time —
areas get resized, moved, split, or released — so keying each box by its exact
``(playerUid, min, max)`` geometry (as the other categories key by position)
would accumulate *every box a player ever owned*: a box that no longer exists
keeps its old key forever and is never evicted, making the dataset effectively
append-only. Instead player claims are keyed per **player**: the newest source
that observed a given ``playerUid`` REPLACES that player's entire set of boxes,
so the published claims always reflect the latest observation of each player
(see ``_fold_player_claims``).

The per-feature ``firstSeenUtc`` timestamp is intentionally dropped from the
merged output so the published dataset cannot be used to chronologically trace
when (or by whom) a feature was first submitted.
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


# Player claims are folded per-PLAYER (see _fold_player_claims), not per-box, so
# this doc key is not listed in _KEY_FNS — the fold special-cases it.


_KEY_FNS: Dict[str, Callable[[Dict[str, Any]], Optional[FeatureKey]]] = {
    "translocators": _abs_key,
    "traders": _trader_key,
    "rapids": _abs_key,
    "traderClaims": _trader_claim_key,
}


def _fold_player_claims(
    wmap: Dict[str, List[Dict[str, Any]]], feats: List[Any]
) -> None:
    """Fold one source's player-claim boxes, keyed per PLAYER (not per box).

    Because sources are folded oldest-first, every player observed in this
    source is newer than any earlier observation, so this source's set of boxes
    for a player REPLACES whatever was stored before. This evicts boxes the
    player has since resized/moved/released instead of accumulating them."""
    by_uid: Dict[str, Dict[FeatureKey, Dict[str, Any]]] = {}
    for f in feats:
        if not isinstance(f, dict):
            continue
        k = _player_claim_key(f)
        if k is None:
            continue
        # k == (uid, min, max); dedup identical boxes reported twice in one source.
        by_uid.setdefault(k[0], {})[k] = f
    for uid, boxes in by_uid.items():
        wmap[uid] = list(boxes.values())


def _source_sort_key(item: Tuple[str, Dict[str, Any]]) -> Tuple[str, str]:
    sid, doc = item
    return (str(doc.get("generatedUtc") or ""), sid)


class Accumulator:
    """Running merge state, so sources can be folded ONE AT A TIME (streaming)
    instead of holding every parsed source document in memory at once. Peak RAM
    is then one source doc + this accumulator, not the sum of all sources."""

    __slots__ = ("winners", "upstream", "world_spawn")

    def __init__(self) -> None:
        self.winners: Dict[str, Dict[FeatureKey, Dict[str, Any]]] = {
            k: {} for k, _ in CATEGORIES
        }
        self.upstream: Optional[str] = None
        self.world_spawn: Optional[Dict[str, Any]] = None


def new_accumulator() -> Accumulator:
    return Accumulator()


def fold_document(acc: Accumulator, doc: Dict[str, Any]) -> None:
    """Merge one source document into ``acc``. Call in ascending priority order
    (oldest first) so the newest observation of any feature wins."""
    if not isinstance(doc, dict):
        return
    if doc.get("upstream"):
        acc.upstream = doc.get("upstream")
    if isinstance(doc.get("worldSpawn"), dict):
        acc.world_spawn = doc.get("worldSpawn")
    for doc_key, _cat in CATEGORIES:
        feats = doc.get(doc_key)
        if not isinstance(feats, list):
            continue
        if doc_key == "playerClaims":
            # Per-player replacement, not per-box union (see _fold_player_claims).
            _fold_player_claims(acc.winners[doc_key], feats)
            continue
        key_fn = _KEY_FNS[doc_key]
        wmap = acc.winners[doc_key]
        for f in feats:
            if not isinstance(f, dict):
                continue
            k = key_fn(f)
            if k is None:
                continue
            wmap[k] = f  # ascending order => newest source wins


def finalize(acc: Accumulator) -> Dict[str, Any]:
    """Produce the merged ``MapExportDocument`` from an accumulator (without
    ``generatedUtc`` — the caller stamps that at publish time)."""
    out: Dict[str, Any] = {}
    if acc.upstream:
        out["upstream"] = acc.upstream
    if acc.world_spawn is not None:
        out["worldSpawn"] = acc.world_spawn
    for doc_key, _cat in CATEGORIES:
        feats: List[Dict[str, Any]] = []
        if doc_key == "playerClaims":
            # winners[playerClaims] maps uid -> list of that player's boxes.
            records: Any = (f for boxes in acc.winners[doc_key].values() for f in boxes)
        else:
            records = acc.winners[doc_key].values()
        for f in records:
            if "firstSeenUtc" in f:
                f = {k: v for k, v in f.items() if k != "firstSeenUtc"}
            feats.append(f)
        out[doc_key] = feats
    return out


def merge_documents(sources: List[Tuple[str, Dict[str, Any]]]) -> Dict[str, Any]:
    """Union-merge the given ``(source_id, MapExportDocument)`` pairs.

    Returns a ``MapExportDocument`` (without ``generatedUtc`` — the caller
    stamps that at publish time)."""
    ordered = sorted((s for s in sources if isinstance(s[1], dict)), key=_source_sort_key)
    acc = new_accumulator()
    for _sid, doc in ordered:
        fold_document(acc, doc)
    return finalize(acc)
