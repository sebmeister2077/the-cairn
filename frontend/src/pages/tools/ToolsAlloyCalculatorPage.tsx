// Alloy calculator tool.
//
// The calculation UI itself is an embed of the community calculator at
// vintagecalc.eu — it is feature-complete and well maintained, so rather than
// re-implementing it we frame it and wrap it with our own intro, an external
// link (so users can open it standalone if the embed is ever blocked), and an
// attribution line.

import { ExternalLink } from "lucide-react";

import { Trans, useTranslation } from "@/lib/i18n";

const ALLOY_CALCULATOR_URL = "https://vintagecalc.eu/alloying/";

// vintagecalc.eu is a third-party, cross-origin page, so the browser's
// same-origin policy prevents us from measuring its content height and truly
// auto-sizing the frame (it also doesn't broadcast its height via postMessage).
// To avoid an inner scrollbar we give the frame a height tall enough to hold
// the calculator and let the page itself be the single scroll container. The
// negative top offset crops the embedded site's own nav bar so it reads as part
// of this page and users can't accidentally navigate the embed away from the
// calculator. These pixel values track the remote layout and may need a nudge
// if vintagecalc.eu changes its design.
const EMBED_HEADER_CROP_PX = document.documentElement.clientWidth < 754 ? 100 : 74;
const EMBED_HEIGHT_PX = 2260;

export function ToolsAlloyCalculatorPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-3">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold">{t("tools.alloyCalculator.pageTitle")}</h1>
          <a
            href={ALLOY_CALCULATOR_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            {t("tools.alloyCalculator.openExternal")}
            <ExternalLink className="size-4" aria-hidden="true" />
          </a>
        </div>
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("tools.alloyCalculator.pageDescription")}
        </p>
        <p className="text-xs text-muted-foreground">
          <Trans
            path="tools.alloyCalculator.attribution"
            components={{
              link: (
                <a
                  href={ALLOY_CALCULATOR_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-dotted underline-offset-2 hover:text-primary"
                />
              ),
            }}
          />
        </p>
      </header>

      <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
        <iframe
          src={ALLOY_CALCULATOR_URL}
          title={t("tools.alloyCalculator.iframeTitle")}
          loading="lazy"
          allow="clipboard-write"
          referrerPolicy="no-referrer-when-downgrade"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          className="block w-full border-0"
          style={{ height: EMBED_HEIGHT_PX, marginTop: -EMBED_HEADER_CROP_PX }}
        />
      </div>
    </div>
  );
}
