// Multi-endpoint editor: dynamic list of TL rows with add/remove,
// label editing, and a "Pick from map" affordance.
//
// Used by the tunnel tool. Each row uses the existing `BlockEditor`
// (X/Y/Z) plus a small label input and a remove button. A footer row
// adds a new endpoint either manually (defaults to centroid) or via
// the landmark/map picker dialog.

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/lib/i18n";
import { MULTI_TUNNEL_SOFT_CAP, endpointCentroid, type TLEndpoint } from "@/lib/tunnel-multi";
import { endpointColor } from "@/lib/tunnel-colors";
import type { Block3 } from "@/lib/tunnel-share";

import { BlockEditor } from "./BlockEditor";

interface EndpointsCardProps {
  endpoints: TLEndpoint[];
  onAddEndpoint: (coord: Block3, label?: string) => void;
  onRemoveEndpoint: (id: string) => void;
  onChangeEndpointCoord: (id: string, coord: Block3) => void;
  onChangeEndpointLabel: (id: string, label: string) => void;
}

export function EndpointsCard({
  endpoints,
  onAddEndpoint,
  onRemoveEndpoint,
  onChangeEndpointCoord,
  onChangeEndpointLabel,
}: EndpointsCardProps) {
  const { t } = useTranslation();

  const canAdd = endpoints.length < MULTI_TUNNEL_SOFT_CAP;
  const canRemove = endpoints.length > 2;

  const handleAddManual = () => {
    if (!canAdd) return;
    const seed = endpointCentroid(endpoints);
    onAddEndpoint(seed);
  };

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("tools.tunnel.sectionEndpoints")}</h2>
        <span className="text-[10px] text-muted-foreground">
          {endpoints.length} / {MULTI_TUNNEL_SOFT_CAP}
        </span>
      </div>

      <ul className="space-y-2">
        {endpoints.map((ep, i) => (
          <li key={ep.id} className="space-y-1.5 rounded border bg-background p-2">
            <div className="flex items-center gap-1.5">
              <span
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white shadow-inner"
                style={{ backgroundColor: endpointColor(i) }}
                aria-hidden
              >
                {i + 1}
              </span>
              <Input
                value={ep.label ?? ""}
                placeholder={t("tools.tunnel.endpointLabelPlaceholder", { index: i + 1 })}
                onChange={(e) => onChangeEndpointLabel(ep.id, e.currentTarget.value)}
                className="h-7 text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => onRemoveEndpoint(ep.id)}
                disabled={!canRemove}
                title={t("tools.tunnel.endpointRemove")}
                aria-label={t("tools.tunnel.endpointRemove")}
                className="h-7 w-7 shrink-0"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
            <BlockEditor
              idPrefix={`tunnel-tl-${ep.id}`}
              label=""
              value={ep.coord}
              onChange={(coord) => onChangeEndpointCoord(ep.id, coord)}
            />
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAddManual}
          disabled={!canAdd}
          className="flex-1"
        >
          <Plus className="mr-1 h-3 w-3" />
          {t("tools.tunnel.endpointAddManual")}
        </Button>
      </div>

      {!canAdd && (
        <p className="text-[10px] text-muted-foreground">
          {t("tools.tunnel.endpointCapHint", { cap: MULTI_TUNNEL_SOFT_CAP })}
        </p>
      )}
    </div>
  );
}
