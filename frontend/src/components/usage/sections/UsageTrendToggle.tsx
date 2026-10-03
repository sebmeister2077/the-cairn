import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

export function TrendToggle({
  checked,
  onChange,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  id: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} size="sm" />
      <Label htmlFor={id} className="text-xs text-muted-foreground cursor-pointer">
        Trend line
      </Label>
    </div>
  );
}
