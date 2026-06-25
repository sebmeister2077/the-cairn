import { useTranslation } from "@/lib/i18n";
import { useState, useRef, useLayoutEffect } from "react";

export function ExpandableDescription({ text }: { text: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const prev = el.style.webkitLineClamp;
      el.style.webkitLineClamp = "2";
      el.style.display = "-webkit-box";
      setOverflows(el.scrollHeight - el.clientHeight > 1);
      el.style.webkitLineClamp = prev;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  return (
    <div className="mt-0.5">
      <p
        ref={ref}
        className={`text-xs text-muted-foreground whitespace-pre-wrap ${expanded ? "" : "line-clamp-2"}`}
        title={overflows && !expanded ? text : undefined}
      >
        {text}
      </p>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-xs font-medium text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          {expanded
            ? t("topsMap.groupingsDrawer.library.showLess")
            : t("topsMap.groupingsDrawer.library.showMore")}
        </button>
      )}
    </div>
  );
}
