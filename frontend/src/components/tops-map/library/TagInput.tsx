import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/lib/i18n";
import { usePopularTags } from "@/hooks/useGroupingLibrary";

const TAG_RE = /^[a-z0-9][a-z0-9 \-]*$/;
const TAG_MAX_LEN = 24;

function normalizeTag(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s || s.length > TAG_MAX_LEN || !TAG_RE.test(s)) return null;
  return s;
}

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  max: number;
  /** Disable the underlying input + suggestions interaction. */
  disabled?: boolean;
  /** Optional id for the labelled input. */
  id?: string;
}

/**
 * Chip-based tag editor with a popular-tags autocomplete dropdown. Accepts
 * Enter / comma to commit a chip; Backspace on an empty input removes the
 * last chip. Suggestions are filtered by the current draft text and skip
 * tags already on the chip list, so users converge on a canonical
 * vocabulary instead of fragmenting it ("elk" vs "Elk").
 */
export function TagInput({ value, onChange, max, disabled, id }: TagInputProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const popular = usePopularTags(draft, !disabled && open);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const suggestions = useMemo(() => {
    const existing = new Set(value);
    return (popular.data ?? []).filter((p) => !existing.has(p.tag)).slice(0, 8);
  }, [popular.data, value]);

  function commit(raw: string) {
    const tag = normalizeTag(raw);
    if (!tag) return;
    if (value.includes(tag)) return;
    if (value.length >= max) return;
    onChange([...value, tag]);
    setDraft("");
  }

  function removeAt(index: number) {
    const next = value.slice();
    next.splice(index, 1);
    onChange(next);
  }

  return (
    <div ref={wrapperRef} className="relative">
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent p-1.5">
        {value.map((tag, i) => (
          <Badge key={tag} variant="secondary" className="gap-1 pl-2 pr-1">
            {tag}
            <button
              type="button"
              aria-label={t("topsMap.groupingsDrawer.library.tagsRemove")}
              className="rounded-sm hover:bg-muted-foreground/20 cursor-pointer"
              onClick={() => removeAt(i)}
              disabled={disabled}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <Input
          id={id}
          value={draft}
          disabled={disabled || value.length >= max}
          placeholder={
            value.length >= max ? "" : t("topsMap.groupingsDrawer.library.tagsPlaceholder")
          }
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Backspace" && !draft && value.length > 0) {
              removeAt(value.length - 1);
            }
          }}
          onBlur={() => {
            if (draft.trim()) commit(draft);
          }}
          className="h-7 flex-1 min-w-24 border-0 px-1 shadow-none focus-visible:ring-0"
        />
      </div>
      {open && suggestions.length > 0 && (
        <ul
          className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
          role="listbox"
        >
          {suggestions.map((s) => (
            <li key={s.tag}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(s.tag);
                }}
                className="flex w-full items-center justify-between rounded-sm px-2 py-1 text-left hover:bg-accent cursor-pointer"
              >
                <span>{s.tag}</span>
                <span className="text-xs text-muted-foreground">{s.count}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
