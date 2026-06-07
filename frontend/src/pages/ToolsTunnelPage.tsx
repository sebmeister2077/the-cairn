// Public tunnel & road builder tool.
//
// URL contract: `/tools?from=x,y,z&to=x,y,z`. When opened from the
// route planner, both endpoints are filled in for a walk leg between
// two TLs. The page renders a controls panel (editable endpoints +
// pattern + stats) and a lazy-loaded 3D previewer of the resulting
// block-by-block dig path.

import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { TunnelControls } from "@/components/tools/TunnelControls";
import { useTranslation } from "@/lib/i18n";
import {
  autoFitPattern,
  clampPattern,
  generateTunnelPath,
  pathStats,
  type TunnelMode,
  type TunnelPattern,
} from "@/lib/tunnel-pattern";
import { parseTunnelToolParams, type Block3 } from "@/lib/tunnel-share";

const TunnelViewer3D = lazy(() => import("@/components/tools/TunnelViewer3D"));

const DEFAULT_FROM: Block3 = { x: 0, y: 110, z: 0 };
const DEFAULT_TO: Block3 = { x: 100, y: 110, z: 30 };
const DEFAULT_MODE: TunnelMode = "bresenham";

const VIEWER_SIZE_CLASSES =
  "h-105 sm:h-130 lg:sticky lg:top-4 lg:h-[calc(100vh-6rem)] lg:max-h-215 lg:min-h-160";

export function ToolsTunnelPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const initial = useMemo(() => parseTunnelToolParams(searchParams), [searchParams]);

  const [from, setFrom] = useState<Block3>(initial.from ?? DEFAULT_FROM);
  const [to, setTo] = useState<Block3>(initial.to ?? DEFAULT_TO);
  const [mode, setMode] = useState<TunnelMode>(DEFAULT_MODE);
  const [pattern, setPattern] = useState<TunnelPattern>(() =>
    autoFitPattern(initial.from ?? DEFAULT_FROM, initial.to ?? DEFAULT_TO),
  );

  // When the URL params change (e.g. user pastes a new link), refresh
  // local state. Skipped on initial mount because state is already
  // seeded from the params.
  useEffect(() => {
    if (initial.from && initial.to) {
      setFrom(initial.from);
      setTo(initial.to);
      setPattern(autoFitPattern(initial.from, initial.to));
    }
  }, [initial.from, initial.to]);

  const path = useMemo(
    () => generateTunnelPath(from, to, clampPattern(pattern), mode),
    [from, to, pattern, mode],
  );
  const stats = useMemo(() => pathStats(path, from, to), [path, from, to]);

  const noEndpoints = !initial.from && !initial.to;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("tools.tunnel.pageTitle")}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("tools.tunnel.pageDescription")}
        </p>
      </header>

      {noEndpoints && (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <div className="font-semibold">{t("tools.tunnel.invalidUrlTitle")}</div>
          <div className="mt-1">
            {t("tools.tunnel.invalidUrlBody")}{" "}
            <Link to="/multiplayer/tops" className="underline">
              Route planner
            </Link>
            .
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_1fr] lg:items-start">
        <TunnelControls
          from={from}
          to={to}
          path={path}
          mode={mode}
          pattern={pattern}
          stats={stats}
          initialFrom={initial.from}
          initialTo={initial.to}
          onChangeFrom={setFrom}
          onChangeTo={setTo}
          onChangeMode={setMode}
          onChangePattern={setPattern}
          onAutoFit={() => setPattern(autoFitPattern(from, to))}
          onReset={() => {
            if (initial.from) setFrom(initial.from);
            if (initial.to) setTo(initial.to);
            if (initial.from && initial.to) {
              setPattern(autoFitPattern(initial.from, initial.to));
            }
            setMode(DEFAULT_MODE);
          }}
        />
        <div className={VIEWER_SIZE_CLASSES}>
          <Suspense fallback={<ViewerLoading />}>
            <TunnelViewer3D path={path} from={from} to={to} />
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
