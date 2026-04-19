import * as React from "react";

interface HelpTipProps {
  text: string;
}

function HelpTip({ text }: HelpTipProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <span className="relative inline-flex ml-1 align-middle">
      <button
        type="button"
        aria-label="Help"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-muted-foreground/40 text-[10px] leading-none text-muted-foreground hover:bg-accent hover:text-accent-foreground cursor-help"
      >
        ?
      </button>
      {open && (
        <span className="absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 whitespace-normal rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md border border-input w-56">
          {text}
        </span>
      )}
    </span>
  );
}

export { HelpTip };
