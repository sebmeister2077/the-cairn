"""N-way merge of per-contributor map-features documents.

Each source is a ``MapExportDocument`` (the combined export the proxy uploads):
``{generatedUtc, upstream, worldSpawn, translocators[], traders[], rapids[],
traderClaims[], playerClaims[]}``. The merge is a **union per category, keyed by
position/identity**, with **last-writer-wins** on conflict (the record from the
source with the newest ``generatedUtc`` wins).

The result is deterministic and order-independent: sources are sorted by
``(generatedUtc, source_id)`` and applied in ascending order, so the newest
observation of any given feature is the one that survives.

**Player claims are special-cased and NOT merged across sources.** A player's
land claims change over time — areas get resized, moved, split, or released —
and every source is an independent full observation of the *same* pinned game
server, so an older source only ever carries a *staler* view of the whole
claim map. Unioning player claims across sources (even keyed per player) lets a
stale source keep contributing boxes for players the newest source has since
seen change or release, inflating the published set with claims that no longer
exist. Instead the whole ``playerClaims`` category is taken verbatim from the
**single newest source that reports any player claims** — the last contribution
wins outright and earlier contributions are discarded, so the published claims
always reflect exactly the latest observation of the server (see
``_replace_player_claims``). A source that reports an empty claim list is
treated as a non-observation and left to the previous good source rather than
wiping the map.

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


# Player claims are taken wholesale from the newest source (see
# _replace_player_claims), never keyed/merged per-box across sources, so this
# doc key is not listed in _KEY_FNS.


_KEY_FNS: Dict[str, Callable[[Dict[str, Any]], Optional[FeatureKey]]] = {
    "translocators": _abs_key,
    "traders": _trader_key,
    "rapids": _abs_key,
    "traderClaims": _trader_claim_key,
}


def _group_player_claims_by_uid(
    feats: List[Any],
) -> Dict[str, Dict[FeatureKey, Dict[str, Any]]]:
    """Group a source's player-claim boxes by ``playerUid`` (deduping identical
    boxes reported twice in one source)."""
    by_uid: Dict[str, Dict[FeatureKey, Dict[str, Any]]] = {}
    for f in feats:
        if not isinstance(f, dict):
            continue
        k = _player_claim_key(f)
        if k is None:
            continue
        # k == (uid, min, max); dedup identical boxes reported twice in one source.
        by_uid.setdefault(k[0], {})[k] = f
    return by_uid


def _replace_player_claims(
    wmap: Dict[str, List[Dict[str, Any]]], feats: List[Any]
) -> None:
    """Replace the ENTIRE player-claims set with this source's observation.

    Sources are folded oldest-first, so the newest source carrying any player
    claims is applied last and its set becomes the published truth — the whole
    category is the *last contribution*, never merged with earlier (staler)
    sources. A source that reports no usable claims is treated as a
    non-observation and leaves the previous good set untouched instead of wiping
    the map."""
    by_uid = _group_player_claims_by_uid(feats)
    if not by_uid:
        return
    wmap.clear()
    for uid, boxes in by_uid.items():
        wmap[uid] = list(boxes.values())


def _fold_player_claims(
    wmap: Dict[str, List[Dict[str, Any]]], feats: List[Any]
) -> None:
    """Fold player-claim boxes keyed per PLAYER (not per box), replacing each
    observed player's whole box set while leaving unobserved players in place.

    Used only for intra-contributor DELTA upserts, where a delta names just the
    players that changed: those players are replaced and everyone else is kept.
    Cross-source full folds use ``_replace_player_claims`` instead."""
    for uid, boxes in _group_player_claims_by_uid(feats).items():
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
            # Whole-category replacement by the last contribution, NOT a per-box
            # or per-player union across sources (see _replace_player_claims).
            _replace_player_claims(acc.winners[doc_key], feats)
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


# ---------------------------------------------------------------------------
# Delta reconstruction
# ---------------------------------------------------------------------------
# A contributor may push an append-only stream of DELTA objects on top of its
# base snapshot instead of re-uploading the whole document. Each delta carries
# ``upserts`` (full feature objects to set) and ``removals`` (identity-only
# objects / playerUids to delete), both keyed per category by the SAME
# ``_KEY_FNS`` the union-merge uses — so the server derives keys itself and no
# cross-language key logic has to stay in lock-step for correctness. The rebuild
# reconstructs the current per-contributor snapshot from ``base`` + ordered
# ``deltas`` and then folds it into the cross-contributor merge unchanged.


def _removal_uid(item: Any) -> Optional[str]:
    """A playerClaims removal entry is either a bare ``playerUid`` string or an
    identity object carrying ``playerUid``."""
    if isinstance(item, str):
        return item or None
    if isinstance(item, dict):
        uid = item.get("playerUid")
        return uid if isinstance(uid, str) and uid else None
    return None


def _apply_upserts(acc: "Accumulator", cats: Dict[str, Any]) -> None:
    for doc_key, _cat in CATEGORIES:
        feats = cats.get(doc_key)
        if not isinstance(feats, list):
            continue
        if doc_key == "playerClaims":
            # An upsert replaces each named player's WHOLE box set, leaving other
            # players in this contributor's snapshot untouched (per-player).
            _fold_player_claims(acc.winners[doc_key], feats)
            continue
        key_fn = _KEY_FNS[doc_key]
        wmap = acc.winners[doc_key]
        for f in feats:
            if not isinstance(f, dict):
                continue
            k = key_fn(f)
            if k is not None:
                wmap[k] = f


def _apply_removals(acc: "Accumulator", cats: Dict[str, Any]) -> None:
    for doc_key, _cat in CATEGORIES:
        feats = cats.get(doc_key)
        if not isinstance(feats, list):
            continue
        wmap = acc.winners[doc_key]
        if doc_key == "playerClaims":
            for item in feats:
                uid = _removal_uid(item)
                if uid is not None:
                    wmap.pop(uid, None)
            continue
        key_fn = _KEY_FNS[doc_key]
        for f in feats:
            if not isinstance(f, dict):
                continue
            k = key_fn(f)
            if k is not None:
                wmap.pop(k, None)


def reconstruct_document(
    base: Optional[Dict[str, Any]], deltas: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """Rebuild a contributor's current ``MapExportDocument`` from its ``base``
    snapshot plus an ordered list of ``deltas`` (ascending ``seq``).

    Each delta is applied in order: envelope metadata (``upstream`` /
    ``worldSpawn``) is overwritten when present, ``upserts`` set features by key,
    and ``removals`` delete them (playerClaims per-player). The result is a
    normal ``MapExportDocument`` ready to fold into the cross-contributor
    accumulator."""
    acc = new_accumulator()
    if isinstance(base, dict):
        fold_document(acc, base)
    for delta in deltas:
        if not isinstance(delta, dict):
            continue
        if delta.get("upstream"):
            acc.upstream = delta.get("upstream")
        if isinstance(delta.get("worldSpawn"), dict):
            acc.world_spawn = delta.get("worldSpawn")
        ups = delta.get("upserts")
        if isinstance(ups, dict):
            _apply_upserts(acc, ups)
        rem = delta.get("removals")
        if isinstance(rem, dict):
            _apply_removals(acc, rem)
    return finalize(acc)
