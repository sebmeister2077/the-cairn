import { Checkbox } from "../ui/checkbox";

export function FilterToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1 cursor-pointer">
      <Checkbox checked={value} onCheckedChange={(checked) => onChange(checked === true)} />
      {label}
    </label>
  );
}
