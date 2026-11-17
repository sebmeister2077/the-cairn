import * as React from "react";
import { createPortal } from "react-dom";

interface HelpTipProps {
  text: string;
}

function HelpTip({ text }: HelpTipProps) {
  const [open, setOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const [coords, setCoords] = React.useState<{ top: number; left: number } | null>(null);

  React.useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setCoords({ top: rect.top, left: rect.left + rect.width / 2 });
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const handler = () => setOpen(false);
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [open]);

  return (
    <span className="relative inline-flex ml-1 align-middle">
      {/* The button is 24px (the minimum touch target) around the 16px circle;
          the negative margin keeps the horizontal spacing of the 16px version. */}
      <button
        ref={buttonRef}
        type="button"
        aria-label="Help"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onBlur={() => setOpen(false)}
        className="group -mx-1 inline-flex size-6 items-center justify-center rounded-full text-muted-foreground cursor-help hover:text-accent-foreground"
      >
        <span
          aria-hidden
          className="inline-flex size-4 items-center justify-center rounded-full border border-muted-foreground/40 text-[10px] leading-none group-hover:bg-accent"
        >
          ?
        </span>
      </button>
      {open &&
        coords &&
        createPortal(
          <span
            style={{
              position: "fixed",
              top: coords.top - 6,
              left: coords.left,
              transform: "translate(-50%, -100%)",
              zIndex: 9999,
            }}
            className="pointer-events-none whitespace-normal rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md border border-input w-56"
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}

export { HelpTip };
