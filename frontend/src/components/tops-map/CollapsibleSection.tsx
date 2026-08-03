import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type CollapsibleSectionProps = {
  title: ReactNode;
  /** Optional count/summary rendered on the right of the header. */
  badge?: ReactNode;
  /** Optional leading icon. */
  icon?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  /** Extra classes for the inner content wrapper (defaults to a vertical stack). */
  contentClassName?: string;
  children: ReactNode;
};

/**
 * Lightweight collapsible group used to declutter the map overlay controls.
 * Shared between the windowed layer panel and the fullscreen overlay so both
 * modes group toggles the same way. Uses the grid-template-rows animation
 * pattern already used elsewhere in the map page.
 */
export function CollapsibleSection({
  title,
  badge,
  icon,
  defaultOpen = false,
  className,
  contentClassName,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <div className={cn("rounded-md border bg-background/95", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex w-full cursor-pointer select-none items-center gap-2 px-3 py-2 text-sm font-medium"
      >
        {icon}
        <span className="flex-1 text-left">{title}</span>
        {badge}
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
      <div
        id={contentId}
        className="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        aria-hidden={!open}
      >
        <div className="overflow-hidden min-h-0">
          <div className={cn("flex flex-col gap-2 px-3 pb-3", contentClassName)}>{children}</div>
        </div>
      </div>
    </div>
  );
}
