// Single (X, Y, Z) input row used by both From and To editors.

import { useTranslation } from "@/lib/i18n";
import type { Block3 } from "@/lib/tunnel-share";
import { IntegerField } from "./IntegerField";

interface BlockEditorProps {
  idPrefix: string;
  label: string;
  value: Block3;
  onChange: (next: Block3) => void;
}

export function BlockEditor({ idPrefix, label, value, onChange }: BlockEditorProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium">{label}</div>
      <div className="grid grid-cols-3 gap-2">
        <IntegerField
          id={`${idPrefix}-x`}
          label={t("tools.tunnel.x")}
          value={value.x}
          onChange={(x) => onChange({ ...value, x })}
        />
        <IntegerField
          id={`${idPrefix}-y`}
          label={t("tools.tunnel.y")}
          value={value.y}
          onChange={(y) => onChange({ ...value, y })}
        />
        <IntegerField
          id={`${idPrefix}-z`}
          label={t("tools.tunnel.z")}
          value={value.z}
          onChange={(z) => onChange({ ...value, z })}
        />
      </div>
    </div>
  );
}
