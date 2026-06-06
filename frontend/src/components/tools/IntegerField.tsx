// Compact integer text input with sign support. Uses `type="text"` +
// `inputMode="numeric"` instead of `type="number"` so:
//   - the native spinner buttons don't eat horizontal space (the
//     coordinate columns are narrow), and
//   - typing partial values like "-" or "" doesn't immediately snap
//     to 0 — we hold a draft string and only commit valid numbers.
//
// Arrow Up / Down still increment by ±1 (±10 with Shift) so keyboard
// users keep the type="number" affordance.

import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface IntegerFieldProps {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  className?: string;
  inputClassName?: string;
  min?: number;
  max?: number;
}

export function IntegerField({
  id,
  label,
  value,
  onChange,
  className,
  inputClassName,
  min,
  max,
}: IntegerFieldProps) {
  const [draft, setDraft] = useState<string>(() => (Number.isFinite(value) ? String(value) : "0"));

  // Sync from external state (e.g. auto-fit, reset).
  useEffect(() => {
    if (Number.isFinite(value) && Number(draft) !== value) {
      setDraft(String(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const clamp = (n: number) => {
    let r = n;
    if (typeof min === "number" && r < min) r = min;
    if (typeof max === "number" && r > max) r = max;
    return r;
  };

  const bump = (delta: number) => {
    const current = Number.isFinite(value) ? value : 0;
    const next = clamp(current + delta);
    if (next === current) return;
    onChange(next);
    setDraft(String(next));
  };

  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <Label
        htmlFor={id}
        className="whitespace-nowrap text-[10px] uppercase tracking-wide text-muted-foreground"
      >
        {label}
      </Label>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          setDraft(raw);
          if (raw === "" || raw === "-") return;
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(clamp(Math.trunc(n)));
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const dir = e.key === "ArrowUp" ? 1 : -1;
            bump(dir * (e.shiftKey ? 10 : 1));
          }
        }}
        onBlur={() => {
          if (draft === "" || draft === "-" || !Number.isFinite(Number(draft))) {
            setDraft(String(value));
          }
        }}
        className={cn("h-8 px-2 font-mono text-sm", inputClassName)}
      />
    </div>
  );
}
