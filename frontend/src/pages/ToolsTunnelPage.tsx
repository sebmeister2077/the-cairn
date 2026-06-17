// Public tunnel & road builder tool.
//
// URL contract (parsed in order):
//   - Multi: `/tools?tls=x,y,z;x,y,z;...&topology=hub|tour|pairs&cost=total|minimax|manhattan`
//   - Legacy: `/tools?from=x,y,z&to=x,y,z` (still accepted)
//
// The page renders a controls panel (endpoints + topology + per-segment
// pattern + stats) and a lazy-loaded 3D previewer that draws every
// segment of the resulting tunnel network.

import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { TunnelControls } from "@/components/tools/TunnelControls";
import { useTranslation } from "@/lib/i18n";
import {
  aggregateMultiStats,
  buildMultiPaths,
  clampMetricToTopology,
  newEndpointId,
  pairwiseEdgeKeys,
  pruneSegments,
  solveHub,
  solveTour,
  type CostMetric,
  type EdgeKey,
  type SegmentSpec,
  type TLEndpoint,
  type Topology,
} from "@/lib/tunnel-multi";
import { parseMultiTunnelParams, type Block3 } from "@/lib/tunnel-share";

const TunnelViewer3D = lazy(() => import("@/components/tools/TunnelViewer3D"));

const DEFAULT_TLS: Block3[] = [
  { x: 0, y: 110, z: 0 },
  { x: 100, y: 110, z: 30 },
];
const DEFAULT_COST: CostMetric = "minimax";

const VIEWER_SIZE_CLASSES =
  "h-105 sm:h-130 lg:sticky lg:top-4 lg:h-[calc(100vh-6rem)] lg:max-h-215 lg:min-h-160";

interface InitialState {
  endpoints: TLEndpoint[];
  topology: Topology;
  costMetric: CostMetric;
}

function makeEndpoints(coords: ReadonlyArray<Block3>): TLEndpoint[] {
  return coords.map((c) => ({ id: newEndpointId(), coord: { ...c } }));
}

function deriveInitial(parsed: ReturnType<typeof parseMultiTunnelParams>): InitialState {
  const tls = parsed.tls && parsed.tls.length >= 1 ? parsed.tls : DEFAULT_TLS;
  // Default topology: ≤2 endpoints fall back to "pairs" (legacy single
  // tunnel). ≥3 endpoints default to "hub" so the multi-TL feature is
  // visible immediately.
  const fallbackTopology: Topology = tls.length >= 3 ? "hub" : "pairs";
  return {
    endpoints: makeEndpoints(tls),
    topology: parsed.topology ?? fallbackTopology,
    costMetric: parsed.costMetric ?? DEFAULT_COST,
  };
}

export function ToolsTunnelPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const initial = useMemo(
    () => deriveInitial(parseMultiTunnelParams(searchParams)),
    [searchParams],
  );

  const [endpoints, setEndpoints] = useState<TLEndpoint[]>(initial.endpoints);
  const [segments, setSegments] = useState<Map<EdgeKey, SegmentSpec>>(() => new Map());
  const [topology, setTopology] = useState<Topology>(initial.topology);
  const [costMetric, setCostMetric] = useState<CostMetric>(initial.costMetric);
  const [enabledPairs, setEnabledPairs] = useState<Set<EdgeKey>>(() => new Set());
  const [selectedEdge, setSelectedEdge] = useState<EdgeKey | null>(null);
  /** User-locked hub coordinate. When null the solver picks the junction. */
  const [hubOverride, setHubOverride] = useState<Block3 | null>(null);

  // When URL params change (e.g. user pastes a new link), reset state.
  useEffect(() => {
    setEndpoints(initial.endpoints);
    setSegments(new Map());
    setTopology(initial.topology);
    setCostMetric(initial.costMetric);
    setEnabledPairs(new Set());
    setSelectedEdge(null);
    setHubOverride(null);
  }, [initial]);

  // Drop segment specs and pair toggles for endpoints that no longer exist.
  useEffect(() => {
    const ids = new Set(endpoints.map((e) => e.id));
    setSegments((prev) => {
      const next = pruneSegments(prev, ids);
      if (next.size === prev.size) return prev;
      return next;
    });
    setEnabledPairs((prev) => {
      const allowed = new Set(pairwiseEdgeKeys(endpoints));
      const next = new Set<EdgeKey>();
      for (const key of prev) {
        const [a, b] = key.split("|");
        if (ids.has(a) && ids.has(b) && allowed.has(key)) next.add(key);
      }
      // Auto-enable any newly-created pairs (added endpoint).
      for (const k of allowed) next.add(k);
      if (next.size === prev.size) {
        let same = true;
        for (const k of prev)
          if (!next.has(k)) {
            same = false;
            break;
          }
        if (same) return prev;
      }
      return next;
    });
  }, [endpoints]);

  // Solve junction / tour order whenever endpoints, topology, or cost
  // metric change. The hub override (when set) wins over the solver so
  // the user can lock the junction at a specific block.
  const solvedJunction = useMemo(() => {
    if (topology !== "hub") return null;
    return solveHub(endpoints, segments, costMetric);
  }, [topology, endpoints, segments, costMetric]);

  const junction = useMemo(() => {
    if (topology !== "hub") return null;
    return hubOverride ?? solvedJunction;
  }, [topology, hubOverride, solvedJunction]);

  const tourOrder = useMemo(() => {
    if (topology !== "tour") return null;
    return solveTour(endpoints, segments, costMetric);
  }, [topology, endpoints, segments, costMetric]);

  const result = useMemo(
    () =>
      buildMultiPaths({
        endpoints,
        segments,
        topology,
        costMetric,
        enabledPairs: topology === "pairs" ? enabledPairs : null,
        tourOrder,
        junction,
      }),
    [endpoints, segments, topology, costMetric, enabledPairs, tourOrder, junction],
  );

  const stats = useMemo(() => aggregateMultiStats(result), [result]);

  // Derive the displayed selection from the user's intent (`selectedEdge`)
  // and the current set of rendered segments. We can't just read `selectedEdge`
  // directly because endpoints/topology changes can leave it pointing at a
  // segment that no longer exists.
  const effectiveSelectedEdge = useMemo<EdgeKey | null>(() => {
    const activeKeys = result.segments.map((s) => s.key);
    if (activeKeys.length === 0) return null;
    if (selectedEdge && activeKeys.includes(selectedEdge)) return selectedEdge;
    return activeKeys[0];
  }, [result, selectedEdge]);

  // ---- mutators -----------------------------------------------------

  const handleAddEndpoint = (coord: Block3, label?: string) => {
    setEndpoints((prev) => [...prev, { id: newEndpointId(), coord, label }]);
  };

  const handleRemoveEndpoint = (id: string) => {
    setEndpoints((prev) => (prev.length <= 2 ? prev : prev.filter((e) => e.id !== id)));
  };

  const handleEndpointCoord = (id: string, coord: Block3) => {
    setEndpoints((prev) => prev.map((e) => (e.id === id ? { ...e, coord } : e)));
  };

  const handleEndpointLabel = (id: string, label: string) => {
    setEndpoints((prev) =>
      prev.map((e) => (e.id === id ? { ...e, label: label || undefined } : e)),
    );
  };

  const handleTogglePair = (key: EdgeKey) => {
    setEnabledPairs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleEnableAllPairs = () => {
    setEnabledPairs(new Set(pairwiseEdgeKeys(endpoints)));
  };

  const handleSegmentChange = (key: EdgeKey, spec: SegmentSpec) => {
    setSegments((prev) => {
      const next = new Map(prev);
      next.set(key, spec);
      return next;
    });
  };

  const handleReset = () => {
    setEndpoints(initial.endpoints);
    setSegments(new Map());
    setTopology(initial.topology);
    setCostMetric(initial.costMetric);
    setEnabledPairs(new Set());
    setSelectedEdge(null);
    setHubOverride(null);
  };

  return (
    <div className="mx-auto max-w-12xl space-y-6 px-4 py-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("tools.tunnel.pageTitle")}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("tools.tunnel.pageDescription")}
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_1fr] lg:items-start">
        <TunnelControls
          endpoints={endpoints}
          segments={segments}
          topology={topology}
          costMetric={costMetric}
          enabledPairs={enabledPairs}
          selectedEdge={effectiveSelectedEdge}
          junction={junction}
          hubOverride={hubOverride}
          tourOrder={tourOrder}
          result={result}
          stats={stats}
          onAddEndpoint={handleAddEndpoint}
          onRemoveEndpoint={handleRemoveEndpoint}
          onChangeEndpointCoord={handleEndpointCoord}
          onChangeEndpointLabel={handleEndpointLabel}
          onChangeTopology={(next) => {
            setTopology(next);
            // Keep the cost metric valid for the new topology (e.g.
            // `balanced` only exists for hub).
            setCostMetric((prev) => clampMetricToTopology(prev, next));
          }}
          onChangeCostMetric={setCostMetric}
          onTogglePair={handleTogglePair}
          onEnableAllPairs={handleEnableAllPairs}
          onChangeSelectedEdge={setSelectedEdge}
          onChangeSegment={handleSegmentChange}
          onChangeHubOverride={setHubOverride}
          onReset={handleReset}
        />
        <div className={VIEWER_SIZE_CLASSES}>
          <Suspense fallback={<ViewerLoading />}>
            <TunnelViewer3D
              endpoints={endpoints}
              junction={junction}
              segments={result.segments}
              selectedEdge={effectiveSelectedEdge}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

function ViewerLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-md border bg-[#1a1a1a] text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      <span className="text-sm">Loading 3D viewer…</span>
    </div>
  );
}
