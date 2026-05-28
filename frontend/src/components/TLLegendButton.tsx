/**
 * Small circular "color palette" button that opens a popover legend
 * explaining what each translocator color means on the map.
 *
 * Used by both the TOPS Map viewer and the Contribute TLs preview map.
 * The Contribute page also unlocks the light-blue "your new TL" entry by
 * passing `showContributeColors`.
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { Palette } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

interface TLLegendButtonProps {
  /** When true, also show the light-blue "Your new TLs" entry. */
  showContributeColors?: boolean;
  /** Optional extra classes for the trigger button (positioning, etc.). */
  className?: string;
}

interface LegendEntry {
  /** CSS color (matches the actual canvas/SVG fill used elsewhere). */
  color: string;
  title: string;
  description: string;
}

// Keep these in sync with:
//   - MapViewer.tsx (canvas line colors for "default" and "user")
//   - TLPreviewMap.tsx STATUS_COLOR["new-confirmed"]
const SERVER_COLOR = "rgb(139, 92, 246)"; // violet-500
const USER_COLOR = "rgb(37, 99, 235)"; // blue-600
const NEW_COLOR = "rgb(14, 165, 233)"; // sky-500
// Mirrors `hoverLineColor` in MapViewer.tsx — used to outline emphasised
// segments (favourite groupings, recently-added emphasis).
const HIGHLIGHT_COLOR = "rgb(243, 232, 255)"; // violet-100
// Mirrors the emerald route stroke in MapViewer.tsx route overlay.
const ROUTE_COLOR = "rgb(16, 185, 129)"; // emerald-500

export function TLLegendButton({ showContributeColors = false, className }: TLLegendButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const [coords, setCoords] = React.useState<{ top: number; left: number } | null>(null);

  React.useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    // Anchor the popover just below the button, right-aligned to it so it
    // doesn't run off the edge when the button sits near the right side.
    setCoords({ top: rect.bottom + 8, left: rect.right });
  }, [open]);

  // Close on outside click, Escape, scroll, or resize.
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const entries: LegendEntry[] = [
    {
      color: SERVER_COLOR,
      title: t("topsMap.translocatorLegend.serverTitle"),
      description: t("topsMap.translocatorLegend.serverDescription"),
    },
    {
      color: USER_COLOR,
      title: t("topsMap.translocatorLegend.playerTitle"),
      description: t("topsMap.translocatorLegend.playerDescription"),
    },
    {
      color: HIGHLIGHT_COLOR,
      title: t("topsMap.translocatorLegend.emphasizedTitle"),
      description: t("topsMap.translocatorLegend.emphasizedDescription"),
    },
    {
      color: ROUTE_COLOR,
      title: t("topsMap.translocatorLegend.routeTitle"),
      description: t("topsMap.translocatorLegend.routeDescription"),
    },
    ...(showContributeColors
      ? [
          {
            color: NEW_COLOR,
            title: t("topsMap.translocatorLegend.newTitle"),
            description: t("topsMap.translocatorLegend.newDescription"),
          },
        ]
      : []),
  ];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={t("topsMap.translocatorLegend.ariaLabel")}
        aria-expanded={open}
        title={t("topsMap.translocatorLegend.title")}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={[
          "inline-flex h-8 w-8 items-center justify-center rounded-full cursor-pointer",
          "border border-input bg-background text-muted-foreground",
          "hover:bg-accent hover:text-accent-foreground",
          "transition-colors shadow-sm",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          // Subtle conic-gradient ring so the button itself hints at "colors".
          "relative",
          className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <span
          aria-hidden
          className="absolute inset-0 rounded-full opacity-70"
          style={{
            background: `conic-gradient(from 0deg, ${SERVER_COLOR}, ${USER_COLOR}, ${NEW_COLOR}, ${SERVER_COLOR})`,
            mask: "radial-gradient(circle, transparent 55%, #000 56%)",
            WebkitMask: "radial-gradient(circle, transparent 55%, #000 56%)",
          }}
        />
        <Palette className="size-4 relative" />
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={t("topsMap.translocatorLegend.ariaLabel")}
            style={{
              position: "fixed",
              top: coords.top,
              left: coords.left,
              transform: "translateX(-100%)",
              zIndex: 9999,
            }}
            className="w-72 rounded-md border border-input bg-popover text-popover-foreground shadow-lg"
          >
            <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("topsMap.translocatorLegend.heading")}
            </div>
            <ul className="divide-y">
              {entries.map((entry) => (
                <li key={entry.title} className="flex items-start gap-3 px-3 py-2.5">
                  <span
                    aria-hidden
                    className="mt-0.5 inline-block h-4 w-4 shrink-0 rounded-full ring-2 ring-background shadow"
                    style={{ backgroundColor: entry.color }}
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium leading-tight">{entry.title}</div>
                    <p className="mt-0.5 text-xs text-muted-foreground leading-snug">
                      {entry.description}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
