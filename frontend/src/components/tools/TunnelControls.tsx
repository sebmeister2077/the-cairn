// Composes the controls cards + the action row (copy share link, reset).

import { useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/component-helpers/copyToClipboard";
import { useTranslation } from "@/lib/i18n";
import type { PathStats, TunnelMode, TunnelPattern } from "@/lib/tunnel-pattern";
import { buildTunnelToolUrl, type Block3 } from "@/lib/tunnel-share";

import { EndpointsCard } from "./EndpointsCard";
import { PatternCard } from "./PatternCard";
import { StatsCard } from "./StatsCard";

interface TunnelControlsProps {
  from: Block3;
  to: Block3;
  path: Block3[];
  mode: TunnelMode;
  pattern: TunnelPattern;
  stats: PathStats;
  initialFrom: Block3 | null;
  initialTo: Block3 | null;
  onChangeFrom: (next: Block3) => void;
  onChangeTo: (next: Block3) => void;
  onChangeMode: (next: TunnelMode) => void;
  onChangePattern: (next: TunnelPattern) => void;
  onAutoFit: () => void;
  onReset: () => void;
}

export function TunnelControls({
  from,
  to,
  path,
  mode,
  pattern,
  stats,
  initialFrom,
  initialTo,
  onChangeFrom,
  onChangeTo,
  onChangeMode,
  onChangePattern,
  onAutoFit,
  onReset,
}: TunnelControlsProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const url = buildTunnelToolUrl(from, to);
    try {
      await copyTextToClipboard(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // swallow; copy failures are non-fatal
    }
  };

  const canReset = initialFrom != null && initialTo != null;

  return (
    <div className="flex flex-col gap-3">
      <EndpointsCard from={from} to={to} onChangeFrom={onChangeFrom} onChangeTo={onChangeTo} />
      <PatternCard
        mode={mode}
        pattern={pattern}
        path={path}
        from={from}
        to={to}
        onChangeMode={onChangeMode}
        onChange={onChangePattern}
        onAutoFit={onAutoFit}
      />
      <StatsCard stats={stats} />
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={handleCopy} className="flex-1">
          {copied ? (
            <>
              <Check className="mr-1 h-3 w-3" />
              {t("tools.tunnel.copyLinkCopied")}
            </>
          ) : (
            <>
              <Copy className="mr-1 h-3 w-3" />
              {t("tools.tunnel.copyLink")}
            </>
          )}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onReset} disabled={!canReset}>
          <RotateCcw className="mr-1 h-3 w-3" />
          {t("tools.tunnel.reset")}
        </Button>
      </div>
    </div>
  );
}
