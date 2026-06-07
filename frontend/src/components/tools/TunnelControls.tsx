// Composes the multi-tunnel controls cards + the action row
// (copy share link, reset).

import { useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/component-helpers/copyToClipboard";
import { useTranslation } from "@/lib/i18n";
import {
  type CostMetric,
  type EdgeKey,
  type MultiPathResult,
  type MultiPathStats,
  type SegmentSpec,
  type TLEndpoint,
  type Topology,
} from "@/lib/tunnel-multi";
import { buildMultiTunnelUrl, type Block3 } from "@/lib/tunnel-share";

import { EndpointsCard } from "./EndpointsCard";
import { PatternCard } from "./PatternCard";
import { StatsCard } from "./StatsCard";
import { TopologyCard } from "./TopologyCard";

interface TunnelControlsProps {
  endpoints: TLEndpoint[];
  segments: Map<EdgeKey, SegmentSpec>;
  topology: Topology;
  costMetric: CostMetric;
  enabledPairs: Set<EdgeKey>;
  selectedEdge: EdgeKey | null;
  junction: Block3 | null;
  hubOverride: Block3 | null;
  tourOrder: string[] | null;
  result: MultiPathResult;
  stats: MultiPathStats;

  onAddEndpoint: (coord: Block3, label?: string) => void;
  onRemoveEndpoint: (id: string) => void;
  onChangeEndpointCoord: (id: string, coord: Block3) => void;
  onChangeEndpointLabel: (id: string, label: string) => void;
  onChangeTopology: (next: Topology) => void;
  onChangeCostMetric: (next: CostMetric) => void;
  onTogglePair: (key: EdgeKey) => void;
  onEnableAllPairs: () => void;
  onChangeSelectedEdge: (key: EdgeKey) => void;
  onChangeSegment: (key: EdgeKey, spec: SegmentSpec) => void;
  onChangeHubOverride: (next: Block3 | null) => void;
  onReset: () => void;
}

export function TunnelControls(props: TunnelControlsProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const tls = props.endpoints.map((e) => e.coord);
    const url = buildMultiTunnelUrl(tls, {
      topology: props.topology,
      costMetric: props.costMetric,
    });
    try {
      await copyTextToClipboard(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // swallow; copy failures are non-fatal
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <EndpointsCard
        endpoints={props.endpoints}
        onAddEndpoint={props.onAddEndpoint}
        onRemoveEndpoint={props.onRemoveEndpoint}
        onChangeEndpointCoord={props.onChangeEndpointCoord}
        onChangeEndpointLabel={props.onChangeEndpointLabel}
      />
      <TopologyCard
        endpoints={props.endpoints}
        topology={props.topology}
        costMetric={props.costMetric}
        enabledPairs={props.enabledPairs}
        junction={props.junction}
        hubOverride={props.hubOverride}
        tourOrder={props.tourOrder}
        onChangeTopology={props.onChangeTopology}
        onChangeCostMetric={props.onChangeCostMetric}
        onTogglePair={props.onTogglePair}
        onEnableAllPairs={props.onEnableAllPairs}
        onChangeHubOverride={props.onChangeHubOverride}
      />
      <PatternCard
        segments={props.result.segments}
        endpoints={props.endpoints}
        selectedEdge={props.selectedEdge}
        onChangeSelectedEdge={props.onChangeSelectedEdge}
        onChangeSegment={props.onChangeSegment}
      />
      <StatsCard stats={props.stats} result={props.result} endpoints={props.endpoints} />
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
        <Button type="button" variant="ghost" size="sm" onClick={props.onReset}>
          <RotateCcw className="mr-1 h-3 w-3" />
          {t("tools.tunnel.reset")}
        </Button>
      </div>
    </div>
  );
}
