// From + To pair, side-by-side on wide screens, stacked on narrow.

import { useTranslation } from "@/lib/i18n";
import type { Block3 } from "@/lib/tunnel-share";
import { BlockEditor } from "./BlockEditor";

interface EndpointsCardProps {
  from: Block3;
  to: Block3;
  onChangeFrom: (next: Block3) => void;
  onChangeTo: (next: Block3) => void;
}

export function EndpointsCard({ from, to, onChangeFrom, onChangeTo }: EndpointsCardProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <h2 className="text-sm font-semibold">{t("tools.tunnel.sectionEndpoints")}</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <BlockEditor
          idPrefix="tunnel-from"
          label={t("tools.tunnel.from")}
          value={from}
          onChange={onChangeFrom}
        />
        <BlockEditor
          idPrefix="tunnel-to"
          label={t("tools.tunnel.to")}
          value={to}
          onChange={onChangeTo}
        />
      </div>
    </div>
  );
}
