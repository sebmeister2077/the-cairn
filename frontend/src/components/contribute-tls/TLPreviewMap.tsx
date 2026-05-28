/**
 * Map preview for the Contribute TLs page.
 *
 * Renders the global TOPS map with two overlay layers:
 *   1. Server-known TLs that the user's contribution *matched* (subset only,
 *      so the map isn't drowned in irrelevant lines).
 *   2. The user's contribution itself \u2014 each TL as a coloured line plus
 *      two square endpoint handles. Endpoints are draggable (image-space
 *      pointer events); two unpaired endpoints can be linked by clicking
 *      them in turn while the "Link" tool is active.
 *
 * Coordinate notes:
 * - Server segment Z is already negated by `useTranslocatorsOverlay()`.
 * - User TL coords come straight from the chat-log and are in *world* Z
 *   (south-positive). The TOPS map's Y axis matches that convention, so we
 *   pass them through unchanged.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { MapViewer, type WorldLineSegment } from "@/components/MapViewer";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  navigateToTL,
  setEditingTLId,
  updateUserTL,
  setMapLocked,
  setDragMode,
  setShowCandidates,
} from "@/store/slices/contributeTLs";
import { reclassifyUserTL, EXACT_MATCH_RADIUS, APPROX_MATCH_RADIUS } from "@/lib/tl-matching";
import { parseLabelCoords } from "@/lib/tl-parser";
import type { UserTL, UserTLEndpoint, TLStatus } from "@/models/contributeTLs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Loader2, Lock, Unlock, Link2 } from "lucide-react";
import { useTopsMapData } from "@/hooks/useTopsMapData";
import { useTranslation } from "@/lib/i18n";

interface TLPreviewMapProps {
  serverSegments: WorldLineSegment[];
}

const STATUS_COLOR: Record<TLStatus, string> = {
  existing: "rgba(16, 185, 129, 0.95)", // emerald
  "new-confirmed": "rgba(14, 165, 233, 0.95)", // sky
  "new-unconfirmed": "rgba(234, 179, 8, 0.95)", // amber
  unpaired: "rgba(239, 68, 68, 0.95)", // red
  invalid: "rgba(244, 63, 94, 0.9)", // rose
};

const STATUS_LABEL: Record<TLStatus, string> = {
  existing: "Already on map",
  "new-confirmed": "New (confirmed)",
  "new-unconfirmed": "New (needs review)",
  unpaired: "Unpaired",
  invalid: "Invalid",
};

interface DragState {
  tlLocalId: string;
  endpoint: "A" | "B";
  /** Image-space coords as the drag progresses. */
  imgX: number;
  imgY: number;
}

export function TLPreviewMap({ serverSegments }: TLPreviewMapProps) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const userTLs = useAppSelector((s) => s.contributeTLs.userTLs);
  const selectedTLId = useAppSelector((s) => s.contributeTLs.selectedTLId);
  const navTick = useAppSelector((s) => s.contributeTLs.navTick);
  const dragMode = useAppSelector((s) => s.contributeTLs.dragMode);
  const mapLocked = useAppSelector((s) => s.contributeTLs.mapLocked);
  const showCandidates = useAppSelector((s) => s.contributeTLs.showCandidates);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [linkPick, setLinkPick] = useState<{ tlLocalId: string; endpoint: "A" | "B" } | null>(null);
  const overlayRootRef = useRef<HTMLDivElement | null>(null);

  // Recompute the focus target whenever navTick bumps (a fresh object
  // identity is what triggers MapViewer's fly-to). Computed inside useMemo
  // so the same selectedTLId clicked twice still produces a new reference.
  const selectedTL = useMemo(
    () => userTLs.find((t) => t.localId === selectedTLId) ?? null,
    [userTLs, selectedTLId],
  );
  const focusPoint = useMemo(() => {
    if (!selectedTL) return undefined;
    const a = selectedTL.endpointA;
    const b = selectedTL.endpointB;
    const x = b ? Math.round((a.x + b.x) / 2) : a.x;
    const z = b ? Math.round((a.z + b.z) / 2) : a.z;
    return { x, z };
    // navTick is intentionally a dep so the same TL re-clicks fly again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTL, navTick]);

  // Filter server segments to just those matched by user TLs (so the map
  // isn't a sea of purple lines).
  const matchedSegmentKeys = useMemo(() => {
    const out = new Set<string>();
    for (const tl of userTLs) {
      if (tl.matchedExistingSegmentKey) out.add(tl.matchedExistingSegmentKey);
    }
    return out;
  }, [userTLs]);

  const filteredServerSegments = useMemo(() => {
    if (matchedSegmentKeys.size === 0) return [];
    return serverSegments.filter((s) => {
      const k = `${s.x1},${s.z1}|${s.x2},${s.z2}`;
      const k2 = `${s.x2},${s.z2}|${s.x1},${s.z1}`;
      return matchedSegmentKeys.has(k) || matchedSegmentKeys.has(k2);
    });
  }, [serverSegments, matchedSegmentKeys]);

  /**
   * Pairing-candidate suggestions for the currently-selected user TL.
   *
   * For every other user TL, if any of its endpoints is within
   * `APPROX_MATCH_RADIUS` of *any* "anchor point" of the selected TL, that
   * endpoint becomes a candidate. Anchors are: the selected TL's own A/B
   * endpoints, plus (if parseable) the destination coords embedded in its
   * chat-log label \u2014 useful when the selected TL is unpaired but the
   * label says "1430 -2150".
   *
   * The line will be drawn from the anchor that triggered the match, so the
   * rendering matches the user's intuition of "this endpoint should pair
   * with that one".
   */
  const candidates = useMemo<
    { tl: UserTL; ep: UserTLEndpoint; from: { x: number; z: number } }[]
  >(() => {
    if (!showCandidates || !selectedTL) return [];
    // Exclude the selected TL's own endpoints from being shown as their own
    // candidates, but allow showing candidates for any status (paired or
    // not) so the toggle is useful in more situations.
    const anchors: { x: number; z: number }[] = [
      { x: selectedTL.endpointA.x, z: selectedTL.endpointA.z },
    ];
    if (selectedTL.endpointB) {
      anchors.push({ x: selectedTL.endpointB.x, z: selectedTL.endpointB.z });
    }
    const labelTarget = parseLabelCoords(selectedTL.endpointA.label);
    if (labelTarget) anchors.push(labelTarget);

    const r2 = APPROX_MATCH_RADIUS * APPROX_MATCH_RADIUS;
    const out: { tl: UserTL; ep: UserTLEndpoint; from: { x: number; z: number } }[] = [];
    for (const tl of userTLs) {
      if (tl.localId === selectedTL.localId) continue;
      // Find the closest (endpoint, anchor) pair for this donor TL.
      let best: { ep: UserTLEndpoint; from: { x: number; z: number }; d2: number } | null = null;
      for (const ep of [tl.endpointA, tl.endpointB] as Array<UserTLEndpoint | null>) {
        if (!ep) continue;
        for (const anchor of anchors) {
          const dx = ep.x - anchor.x;
          const dz = ep.z - anchor.z;
          const d2 = dx * dx + dz * dz;
          // Skip exact-match (they're already considered the same point).
          if (d2 === 0) continue;
          if (d2 > r2) continue;
          if (!best || d2 < best.d2) best = { ep, from: anchor, d2 };
        }
      }
      if (best) out.push({ tl, ep: best.ep, from: best.from });
    }
    return out;
  }, [showCandidates, selectedTL, userTLs]);

  /**
   * Replace the selected TL's endpointB with the picked candidate endpoint
   * and mark the donor TL as `invalid` so the user can prune it. Mirrors
   * the link-mode merge logic in {@link handleEndpointPointerDown}.
   */
  const handleCandidateClick = useCallback(
    (donor: UserTL, donorEp: UserTLEndpoint) => {
      if (!selectedTL) return;
      const merged: UserTL = {
        ...selectedTL,
        endpointB: { ...donorEp },
        pairConfidence: "manual",
      };
      dispatch(updateUserTL(reclassifyUserTL(merged, serverSegments)));
      dispatch(
        updateUserTL({
          ...donor,
          status: "invalid",
          invalidReason: t("contributeTLsPage.previewMap.mergedInvalidReason"),
          pairConfidence: "none",
          endpointB: null,
        }),
      );
    },
    [dispatch, selectedTL, serverSegments, t],
  );

  // Convert image-space coords back to world coords given stats + image.
  const imageToWorld = useCallback(
    (
      imgX: number,
      imgY: number,
      stats: { start_x: number; start_z: number; width_blocks: number; height_blocks: number },
      imgNatural: { w: number; h: number },
    ) => {
      const worldX = (imgX / imgNatural.w) * stats.width_blocks + stats.start_x;
      const worldZ = (imgY / imgNatural.h) * stats.height_blocks + stats.start_z;
      return { x: Math.round(worldX), z: Math.round(worldZ) };
    },
    [],
  );

  // Snap to an existing endpoint within EXACT_MATCH_RADIUS (world blocks).
  const snapToExisting = useCallback(
    (x: number, z: number, ignoreLocalId: string): { x: number; z: number } | null => {
      const r2 = EXACT_MATCH_RADIUS * EXACT_MATCH_RADIUS;
      for (const tl of userTLs) {
        if (tl.localId === ignoreLocalId) continue;
        for (const ep of [tl.endpointA, tl.endpointB] as Array<UserTLEndpoint | null>) {
          if (!ep) continue;
          const dx = ep.x - x;
          const dz = ep.z - z;
          if (dx * dx + dz * dz <= r2) return { x: ep.x, z: ep.z };
        }
      }
      return null;
    },
    [userTLs],
  );

  const handleEndpointPointerDown = useCallback(
    (e: React.PointerEvent, tl: UserTL, endpoint: "A" | "B", imgX: number, imgY: number) => {
      e.stopPropagation();
      // navigateToTL = select + bump nav tick so the review list scrolls
      // and flashes the corresponding row.
      dispatch(navigateToTL(tl.localId));

      if (dragMode === "link") {
        if (linkPick && linkPick.tlLocalId !== tl.localId) {
          // Link the previously-picked endpoint with this one by
          // joining the two TLs' singletons into one paired TL.
          const other = userTLs.find((t) => t.localId === linkPick.tlLocalId);
          const otherEp = other && (linkPick.endpoint === "A" ? other.endpointA : other.endpointB);
          if (other && otherEp) {
            const updated: UserTL = {
              ...tl,
              endpointB: endpoint === "A" ? { ...otherEp } : tl.endpointB,
              endpointA: endpoint === "B" ? { ...otherEp } : tl.endpointA,
              pairConfidence: "manual",
            };
            dispatch(updateUserTL(reclassifyUserTL(updated, serverSegments)));
            // Drop the donor TL since we merged its endpoint into `tl`.
            dispatch(
              updateUserTL({
                ...other,
                endpointA: linkPick.endpoint === "A" ? other.endpointA : other.endpointA,
                // Mark donor as invalid so the user can prune it.
                status: "invalid",
                invalidReason: t("contributeTLsPage.previewMap.mergedInvalidReason"),
                pairConfidence: "none",
                endpointB: null,
              }),
            );
          }
          setLinkPick(null);
          return;
        }
        setLinkPick({ tlLocalId: tl.localId, endpoint });
        return;
      }

      // Default drag-to-move behaviour.
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setDrag({ tlLocalId: tl.localId, endpoint, imgX, imgY });
    },
    [dispatch, dragMode, linkPick, serverSegments, t, userTLs],
  );

  const handleOverlayPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      // Convert client coords to image-space: walk up to the overlay root
      // (which sits inside the same transformed container as the tiles).
      const root = overlayRootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      // The overlay root is a 1:1 image-space layer; rect.width matches
      // the on-screen size of `imgNatural.w * zoom`. We just need the
      // ratio of the cursor position within that rect.
      if (rect.width <= 0 || rect.height <= 0) return;
      const xFrac = (e.clientX - rect.left) / rect.width;
      const yFrac = (e.clientY - rect.top) / rect.height;
      // imgX/imgY are stored in image-space pixels using the natural
      // dimensions. We don't know imgNatural here, so we reconstruct
      // by reusing the value present in `drag` as a starting baseline:
      // every move overwrites the image-space coordinate with the same
      // basis (rect spans the natural image), so:
      //   pixelX = xFrac * naturalWidth
      // We don't have naturalWidth here either; instead store it on the
      // overlay root via data attributes.
      const w = Number(root.dataset.imgw ?? "0");
      const h = Number(root.dataset.imgh ?? "0");
      if (w <= 0 || h <= 0) return;
      setDrag({ ...drag, imgX: xFrac * w, imgY: yFrac * h });
    },
    [drag],
  );

  const handleOverlayPointerUp = useCallback(() => {
    if (!drag) return;
    const root = overlayRootRef.current;
    if (!root) {
      setDrag(null);
      return;
    }
    const stats = {
      start_x: Number(root.dataset.startx ?? "0"),
      start_z: Number(root.dataset.startz ?? "0"),
      width_blocks: Number(root.dataset.wblocks ?? "0"),
      height_blocks: Number(root.dataset.hblocks ?? "0"),
    };
    const imgNatural = {
      w: Number(root.dataset.imgw ?? "0"),
      h: Number(root.dataset.imgh ?? "0"),
    };
    if (!Number.isFinite(stats.width_blocks) || stats.width_blocks <= 0 || imgNatural.w <= 0) {
      setDrag(null);
      return;
    }
    const world = imageToWorld(drag.imgX, drag.imgY, stats, imgNatural);
    const tl = userTLs.find((t) => t.localId === drag.tlLocalId);
    if (tl) {
      const snapped = snapToExisting(world.x, world.z, tl.localId) ?? world;
      const nextEp: UserTLEndpoint = {
        x: snapped.x,
        z: snapped.z,
        sourceWaypointIndex:
          drag.endpoint === "A"
            ? tl.endpointA.sourceWaypointIndex
            : (tl.endpointB?.sourceWaypointIndex ?? -1),
        label: drag.endpoint === "A" ? tl.endpointA.label : (tl.endpointB?.label ?? ""),
      };
      const next: UserTL = {
        ...tl,
        endpointA: drag.endpoint === "A" ? nextEp : tl.endpointA,
        endpointB: drag.endpoint === "B" ? nextEp : tl.endpointB,
      };
      dispatch(updateUserTL(reclassifyUserTL(next, serverSegments)));
    }
    setDrag(null);
  }, [drag, dispatch, imageToWorld, serverSegments, snapToExisting, userTLs]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        {/* <div className="flex items-center gap-2">
          <Switch
            id="contribute-map-lock"
            checked={mapLocked}
            onCheckedChange={(v) => dispatch(setMapLocked(v))}
          />
          <Label htmlFor="contribute-map-lock" className="flex items-center gap-1">
            {mapLocked ? <Lock className="size-4" /> : <Unlock className="size-4" />}
            Lock map
          </Label>
        </div> */}
        <Button
          type="button"
          size="sm"
          variant={dragMode === "link" ? "default" : "outline"}
          onClick={() => dispatch(setDragMode(dragMode === "link" ? "none" : "link"))}
        >
          <Link2 className="size-4 mr-1" />
          {dragMode === "link"
            ? t("contributeTLsPage.previewMap.linking")
            : t("contributeTLsPage.previewMap.linkTwoTls")}
        </Button>
        <div className="flex items-center gap-2">
          <Switch
            id="contribute-show-candidates"
            checked={showCandidates}
            onCheckedChange={(v) => dispatch(setShowCandidates(v))}
          />
          <Label htmlFor="contribute-show-candidates" className="text-xs">
            {t("contributeTLsPage.previewMap.showPairingCandidates")}
          </Label>
        </div>
        <span className="text-xs text-muted-foreground">
          {t("contributeTLsPage.previewMap.dragHelp", { radius: EXACT_MATCH_RADIUS })}
        </span>
      </div>

      <MapViewerWithUserTLs
        serverSegments={filteredServerSegments}
        // interactionsLocked={mapLocked || drag != null}
        onOverlayPointerMove={handleOverlayPointerMove}
        onOverlayPointerUp={handleOverlayPointerUp}
        overlayRootRef={overlayRootRef}
        userTLs={userTLs}
        selectedTLId={selectedTLId}
        onSelectTL={(id) => dispatch(navigateToTL(id))}
        onEditTL={(id) => dispatch(setEditingTLId(id))}
        onEndpointPointerDown={handleEndpointPointerDown}
        onCandidateClick={handleCandidateClick}
        drag={drag}
        linkPick={linkPick}
        focusPoint={focusPoint}
        showCandidates={showCandidates}
        candidates={candidates}
        selectedTL={selectedTL}
      />
    </div>
  );
}

interface InnerProps {
  serverSegments: WorldLineSegment[];
  interactionsLocked?: boolean;
  onOverlayPointerMove: (e: React.PointerEvent) => void;
  onOverlayPointerUp: (e: React.PointerEvent) => void;
  overlayRootRef: React.MutableRefObject<HTMLDivElement | null>;
  userTLs: UserTL[];
  selectedTLId: string | null;
  onSelectTL: (id: string) => void;
  onEditTL: (id: string) => void;
  onEndpointPointerDown: (
    e: React.PointerEvent,
    tl: UserTL,
    endpoint: "A" | "B",
    imgX: number,
    imgY: number,
  ) => void;
  onCandidateClick: (donor: UserTL, donorEp: UserTLEndpoint) => void;
  drag: DragState | null;
  linkPick: { tlLocalId: string; endpoint: "A" | "B" } | null;
  focusPoint: { x: number; z: number } | undefined;
  showCandidates: boolean;
  /** Pre-computed list of candidate endpoints for the selected TL. */
  candidates: { tl: UserTL; ep: UserTLEndpoint; from: { x: number; z: number } }[];
  /** The selected user TL itself, or null. Used as the start of candidate lines. */
  selectedTL: UserTL | null;
}

function MapViewerWithUserTLs(props: InnerProps) {
  const { t } = useTranslation();
  const {
    serverSegments,
    interactionsLocked,
    onOverlayPointerMove,
    onOverlayPointerUp,
    overlayRootRef,
    userTLs,
    selectedTLId,
    onSelectTL,
    onEditTL,
    onEndpointPointerDown,
    onCandidateClick,
    drag,
    linkPick,
    focusPoint,
    showCandidates,
    candidates,
    selectedTL,
  } = props;
  const { tileSet, stats, isLoading, error } = useTopsMapData();
  const statusLabel: Record<TLStatus, string> = {
    existing: t("contributeTLsPage.previewMap.statuses.existing"),
    "new-confirmed": t("contributeTLsPage.previewMap.statuses.newConfirmed"),
    "new-unconfirmed": t("contributeTLsPage.previewMap.statuses.newNeedsReview"),
    unpaired: t("contributeTLsPage.previewMap.statuses.unpaired"),
    invalid: t("contributeTLsPage.previewMap.statuses.invalid"),
  };

  if (error) {
    return (
      <div className="rounded-md border border-red-500/50 bg-red-50 p-4 text-sm text-red-700">
        {t("contributeTLsPage.previewMap.globalMapLoadFailed", { error })}
      </div>
    );
  }
  if (!tileSet || !stats) {
    return (
      <div className="flex items-center justify-center rounded-md border bg-muted/30 p-12 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {isLoading
          ? t("contributeTLsPage.previewMap.loadingMap")
          : t("contributeTLsPage.previewMap.mapUnavailable")}
      </div>
    );
  }

  return (
    <MapViewer
      tileSet={tileSet}
      stats={stats}
      alt={t("contributeTLsPage.previewMap.mapAlt")}
      showTLLegend
      tlLegendShowContributeColors
      overlaySegments={serverSegments}
      interactionsLocked={interactionsLocked}
      focusPoint={focusPoint}
      overlayRender={({ zoom, imgNatural }) => {
        const toImgX = (x: number) => ((x - stats.start_x) / stats.width_blocks) * imgNatural.w;
        const toImgY = (z: number) => ((z - stats.start_z) / stats.height_blocks) * imgNatural.h;

        // Most handles stay ~10 on-screen pixels. Unpaired TLs grow when
        // zoomed in so single endpoints are easier to spot and grab.
        const safeZoom = Math.max(zoom, 0.001);
        const baseHandleScreenSize = 10;
        const unpairedHandleScreenSize = Math.min(
          24,
          baseHandleScreenSize + Math.max(0, zoom - 1) * 3,
        );
        const handleHalfForStatus = (status: TLStatus) =>
          (status === "unpaired" ? unpairedHandleScreenSize : baseHandleScreenSize) / safeZoom / 2;
        const lineWidth = 2 / Math.max(zoom, 0.001);

        return (
          <div
            ref={overlayRootRef}
            data-imgw={imgNatural.w}
            data-imgh={imgNatural.h}
            data-startx={stats.start_x}
            data-startz={stats.start_z}
            data-wblocks={stats.width_blocks}
            data-hblocks={stats.height_blocks}
            onPointerMove={onOverlayPointerMove}
            onPointerUp={onOverlayPointerUp}
            onPointerCancel={onOverlayPointerUp}
            style={{
              position: "absolute",
              inset: 0,
              width: imgNatural.w,
              height: imgNatural.h,
              pointerEvents: "auto",
            }}
          >
            <svg
              width={imgNatural.w}
              height={imgNatural.h}
              viewBox={`0 0 ${imgNatural.w} ${imgNatural.h}`}
              style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
                overflow: "visible",
              }}
            >
              {userTLs.map((tl) => {
                // Already-on-map TLs are rendered solely by the server
                // overlay (purple). Skip them here to avoid stacking a
                // second-coloured line and handles on top.
                if (tl.status === "existing") return null;
                const color = STATUS_COLOR[tl.status];
                const isSelected = tl.localId === selectedTLId;
                const half = handleHalfForStatus(tl.status);
                const aImgX = toImgX(tl.endpointA.x);
                const aImgY = toImgY(tl.endpointA.z);
                const liveDrag = drag && drag.tlLocalId === tl.localId ? drag : null;
                const aPos =
                  liveDrag && liveDrag.endpoint === "A"
                    ? { x: liveDrag.imgX, y: liveDrag.imgY }
                    : { x: aImgX, y: aImgY };

                let line: React.ReactNode = null;
                let bSquare: React.ReactNode = null;
                if (tl.endpointB) {
                  const bImgX = toImgX(tl.endpointB.x);
                  const bImgY = toImgY(tl.endpointB.z);
                  const bPos =
                    liveDrag && liveDrag.endpoint === "B"
                      ? { x: liveDrag.imgX, y: liveDrag.imgY }
                      : { x: bImgX, y: bImgY };
                  line = (
                    <line
                      x1={aPos.x}
                      y1={aPos.y}
                      x2={bPos.x}
                      y2={bPos.y}
                      stroke={color}
                      strokeWidth={lineWidth * (isSelected ? 2 : 1)}
                      strokeOpacity={isSelected ? 1 : 0.85}
                    />
                  );
                  bSquare = (
                    <EndpointHandle
                      cx={bPos.x}
                      cy={bPos.y}
                      half={half}
                      color={color}
                      isSelected={isSelected}
                      isLinkTarget={linkPick?.tlLocalId === tl.localId && linkPick.endpoint === "B"}
                      onPointerDown={(e) => onEndpointPointerDown(e, tl, "B", bPos.x, bPos.y)}
                      onClick={() => {
                        onSelectTL(tl.localId);
                      }}
                      onDoubleClick={() => onEditTL(tl.localId)}
                      tooltip={`${statusLabel[tl.status]} \u2014 ${tl.endpointB!.label}`}
                    />
                  );
                }

                return (
                  <g key={tl.localId}>
                    {line}
                    <EndpointHandle
                      cx={aPos.x}
                      cy={aPos.y}
                      half={half}
                      color={color}
                      isSelected={isSelected}
                      isLinkTarget={linkPick?.tlLocalId === tl.localId && linkPick.endpoint === "A"}
                      onPointerDown={(e) => onEndpointPointerDown(e, tl, "A", aPos.x, aPos.y)}
                      onClick={() => onSelectTL(tl.localId)}
                      onDoubleClick={() => onEditTL(tl.localId)}
                      tooltip={`${statusLabel[tl.status]} \u2014 ${tl.endpointA.label}`}
                    />
                    {bSquare}
                  </g>
                );
              })}
              {showCandidates &&
                selectedTL &&
                candidates.map(({ tl: cand, ep, from }, i) => {
                  const sx = toImgX(from.x);
                  const sy = toImgY(from.z);
                  const ex = toImgX(ep.x);
                  const ey = toImgY(ep.z);
                  const stroke = "rgba(234, 179, 8, 0.8)"; // amber, matches new-unconfirmed
                  // Wide invisible hit-line on top of the visible dashed
                  // line, so the user has a generous click target.
                  return (
                    <g key={`cand-${cand.localId}-${i}`}>
                      <line
                        x1={sx}
                        y1={sy}
                        x2={ex}
                        y2={ey}
                        stroke={stroke}
                        strokeWidth={lineWidth}
                        strokeDasharray={`${lineWidth * 4} ${lineWidth * 3}`}
                        strokeOpacity={0.7}
                      />
                      <line
                        x1={sx}
                        y1={sy}
                        x2={ex}
                        y2={ey}
                        stroke="transparent"
                        strokeWidth={lineWidth * 6}
                        style={{ cursor: "pointer", pointerEvents: "stroke" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onCandidateClick(cand, ep);
                        }}
                      >
                        <title>
                          {t("contributeTLsPage.previewMap.candidateTooltip", {
                            x: ep.x,
                            z: ep.z,
                          })}
                        </title>
                      </line>
                    </g>
                  );
                })}
            </svg>
          </div>
        );
      }}
    />
  );
}

interface EndpointHandleProps {
  cx: number;
  cy: number;
  half: number;
  color: string;
  isSelected: boolean;
  isLinkTarget: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onClick: () => void;
  onDoubleClick: () => void;
  tooltip: string;
}

function EndpointHandle({
  cx,
  cy,
  half,
  color,
  isSelected,
  isLinkTarget,
  onPointerDown,
  onClick,
  onDoubleClick,
  tooltip,
}: EndpointHandleProps) {
  return (
    <rect
      x={cx - half}
      y={cy - half}
      width={half * 2}
      height={half * 2}
      fill={color}
      stroke={isLinkTarget ? "#fbbf24" : isSelected ? "#fff" : "rgba(0,0,0,0.7)"}
      strokeWidth={(isSelected || isLinkTarget ? 2 : 1) * (half / 5)}
      style={{
        cursor: "grab",
        pointerEvents: "auto",
      }}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <title>{tooltip}</title>
    </rect>
  );
}
