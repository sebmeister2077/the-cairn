import * as React from "react";
import { cn } from "@/lib/utils";

interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  /** Called only when the user selects a suggestion (click or Enter). */
  onSelect?: (value: string) => void;
  /** Called when the input receives focus. */
  onFocus?: () => void;
  suggestions: string[];
  placeholder?: string;
  id?: string;
  className?: string;
  /**
   * When true, render the suggestion list *above* the input instead of below.
   * Useful when the combobox sits near the bottom of the viewport (e.g. a
   * floating fullscreen panel) and the default downward list would be clipped.
   */
  dropUp?: boolean;
}

function Combobox({
  value,
  onChange,
  onSelect,
  onFocus,
  suggestions,
  placeholder,
  id,
  className,
  dropUp = false,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);

  const filtered = React.useMemo(() => {
    if (!value) return suggestions;
    const lower = value.toLowerCase();
    return suggestions.filter((s) => s.toLowerCase().includes(lower));
  }, [value, suggestions]);

  // Close on outside click
  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Reset active index when filtered list changes
  React.useEffect(() => {
    setActiveIndex(-1);
  }, [filtered.length, value]);

  // Scroll active item into view
  React.useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const item = listRef.current.children[activeIndex] as HTMLElement;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true);
      return;
    }
    if (!open) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => (i < filtered.length - 1 ? i + 1 : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => (i > 0 ? i - 1 : filtered.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        if (activeIndex >= 0 && filtered[activeIndex]) {
          onChange(filtered[activeIndex]);
          onSelect?.(filtered[activeIndex]);
          setOpen(false);
        }
        break;
      case "Escape":
        setOpen(false);
        break;
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-activedescendant={
          activeIndex >= 0 ? `${id}-opt-${activeIndex}` : undefined
        }
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => { setOpen(true); onFocus?.(); }}
        onKeyDown={handleKeyDown}
        className={cn(
          "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80",
          className
        )}
      />
      {open && filtered.length > 0 && (
        <ul
          ref={listRef}
          role="listbox"
          className={cn(
            "absolute z-50 max-h-48 w-full overflow-auto rounded-lg border border-input bg-popover p-1 shadow-md",
            dropUp ? "bottom-full mb-1" : "mt-1",
          )}
        >
          {filtered.map((item, i) => (
            <li
              key={item}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              data-active={i === activeIndex ? "" : undefined}
              className={cn(
                "cursor-pointer select-none rounded-md px-2 py-1 text-sm",
                i === activeIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50"
              )}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus on input
                onChange(item);
                onSelect?.(item);
                setOpen(false);
              }}
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export { Combobox };
export type { ComboboxProps };
