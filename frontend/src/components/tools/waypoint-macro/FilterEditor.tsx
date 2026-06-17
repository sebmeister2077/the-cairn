// Editable list of waypoint filters used by the Upload and Import modes.

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, X } from "lucide-react";
import { makeDefaultFilter, type FilterType, type WaypointFilter } from "@/lib/waypoint-filters";

interface FilterEditorProps {
  filters: WaypointFilter[];
  onChange: (filters: WaypointFilter[]) => void;
  /** Whether the icon filter is offered (chat-log uploads carry icons). */
  allowIcon?: boolean;
}

const FILTER_TYPE_LABELS: Record<FilterType, string> = {
  name: "Name",
  icon: "Icon",
  color: "Color",
  radius: "Distance",
  idRange: "Id range",
};

export function FilterEditor({ filters, onChange, allowIcon = false }: FilterEditorProps) {
  function update(id: string, patch: Partial<WaypointFilter>) {
    onChange(filters.map((f) => (f.id === id ? ({ ...f, ...patch } as WaypointFilter) : f)));
  }

  function remove(id: string) {
    onChange(filters.filter((f) => f.id !== id));
  }

  function add(type: FilterType) {
    onChange([...filters, makeDefaultFilter(type)]);
  }

  const types: FilterType[] = allowIcon
    ? ["name", "icon", "color", "radius", "idRange"]
    : ["name", "color", "radius", "idRange"];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Filters</span>
        {types.map((type) => (
          <Button key={type} type="button" variant="outline" size="sm" onClick={() => add(type)}>
            <Plus className="size-3.5" /> {FILTER_TYPE_LABELS[type]}
          </Button>
        ))}
      </div>

      {filters.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No filters — every waypoint is included. Add a filter to narrow the list.
        </p>
      )}

      <div className="space-y-2">
        {filters.map((f) => (
          <div
            key={f.id}
            className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-2"
          >
            <FilterRow filter={f} update={(patch) => update(f.id, patch)} />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => remove(f.id)}
              aria-label="Remove filter"
            >
              <X className="size-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilterRow({
  filter,
  update,
}: {
  filter: WaypointFilter;
  update: (patch: Partial<WaypointFilter>) => void;
}) {
  switch (filter.type) {
    case "name":
      return (
        <>
          <span className="self-center text-sm font-medium">Name</span>
          <Select value={filter.mode} onValueChange={(v) => v && update({ mode: v as never })}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="startsWith">starts with</SelectItem>
              <SelectItem value="notStartsWith">does not start with</SelectItem>
              <SelectItem value="contains">contains</SelectItem>
              <SelectItem value="notContains">does not contain</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="w-44"
            value={filter.value}
            placeholder="text…"
            onChange={(e) => update({ value: e.target.value })}
          />
          <label className="flex items-center gap-1 self-center text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={filter.caseSensitive}
              onChange={(e) => update({ caseSensitive: e.target.checked })}
            />
            Case sensitive
          </label>
        </>
      );
    case "icon":
      return (
        <>
          <span className="self-center text-sm font-medium">Icon</span>
          <Select value={filter.mode} onValueChange={(v) => v && update({ mode: v as never })}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="is">is</SelectItem>
              <SelectItem value="isNot">is not</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="w-36"
            value={filter.value}
            placeholder="e.g. spiral"
            onChange={(e) => update({ value: e.target.value })}
          />
        </>
      );
    case "color":
      return (
        <>
          <span className="self-center text-sm font-medium">Color</span>
          <Select value={filter.mode} onValueChange={(v) => v && update({ mode: v as never })}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="is">is</SelectItem>
              <SelectItem value="isNot">is not</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="w-32"
            value={filter.value}
            placeholder="#204EA2"
            onChange={(e) => update({ value: e.target.value })}
          />
        </>
      );
    case "radius":
      return (
        <>
          <span className="self-center text-sm font-medium">Distance</span>
          <Select value={filter.mode} onValueChange={(v) => v && update({ mode: v as never })}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="within">within</SelectItem>
              <SelectItem value="beyond">beyond</SelectItem>
            </SelectContent>
          </Select>
          <NumberField
            label="radius"
            value={filter.radius}
            onChange={(n) => update({ radius: n })}
          />
          <span className="self-center text-xs text-muted-foreground">blocks of</span>
          <NumberField label="X" value={filter.x} onChange={(n) => update({ x: n })} />
          <NumberField label="Z" value={filter.z} onChange={(n) => update({ z: n })} />
        </>
      );
    case "idRange":
      return (
        <>
          <span className="self-center text-sm font-medium">Id range</span>
          <NumberField label="min" value={filter.min} onChange={(n) => update({ min: n })} />
          <NumberField label="max" value={filter.max} onChange={(n) => update({ max: n })} />
        </>
      );
  }
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="grid gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="number"
        className="w-24"
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
