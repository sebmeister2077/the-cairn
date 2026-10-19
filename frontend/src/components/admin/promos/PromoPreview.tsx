import { CalendarDays, ExternalLink, Hammer, MapPin, Trophy, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type PromoContent } from "@/lib/helpers/api";

/**
 * Non-interactive, visual-only preview of how a promo renders for visitors —
 * both the slim site-wide banner and the expanded details dialog. Driven by the
 * editor's live form state (not the network), so an editor can eyeball changes
 * before saving. Kept markup-in-sync with
 * [components/other/EventPromoBanner.tsx].
 */
export function PromoPreview({
  title,
  content,
  imageSrc,
}: {
  title: string;
  content: PromoContent;
  imageSrc: string | null;
}) {
  const schedule = content.schedule ?? [];
  const displayTitle = title.trim() || "Untitled promo";

  return (
    <div className="space-y-4">
      {/* --- Banner strip ----------------------------------------------- */}
      <section className="space-y-1.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Banner
        </p>
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
          <Hammer className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <span className="font-medium">{displayTitle}</span>
            {content.subtitle ? (
              <span className="hidden sm:inline text-amber-800 dark:text-amber-200/90">
                {" "}
                {content.subtitle}
              </span>
            ) : null}
          </div>
          <Button size="xs" variant="secondary" className="pointer-events-none shrink-0">
            Details
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            className="pointer-events-none shrink-0"
            aria-hidden
            tabIndex={-1}
          >
            <X />
          </Button>
        </div>
      </section>

      {/* --- Details dialog --------------------------------------------- */}
      <section className="space-y-1.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Details dialog
        </p>
        <div className="space-y-4 rounded-lg border border-border p-4">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-semibold">
              <Hammer className="size-5 text-amber-600 dark:text-amber-400" />
              {displayTitle}
            </h3>
            {content.hostedBy || content.hosts ? (
              <p className="text-sm text-muted-foreground">
                {content.hostedBy ? `Hosted at ${content.hostedBy}` : "Hosted"}
                {content.hosts ? ` by ${content.hosts}` : ""}.
              </p>
            ) : null}
          </div>

          {imageSrc ? (
            <img
              src={imageSrc}
              alt={displayTitle}
              className="w-full rounded-lg border border-border"
            />
          ) : null}

          {content.summary ? (
            <p className="text-sm text-foreground whitespace-pre-wrap">{content.summary}</p>
          ) : null}

          {content.registration || content.prize || content.hosts ? (
            <ul className="space-y-2 text-sm">
              {content.registration ? (
                <li className="flex items-start gap-2">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="font-medium text-foreground">Register &amp; rules: </span>
                    {content.registration}{" "}
                    {content.mapUrl ? (
                      <span className="font-medium text-primary underline underline-offset-2">
                        Show on map
                      </span>
                    ) : null}
                  </span>
                </li>
              ) : null}
              {content.prize ? (
                <li className="flex items-start gap-2">
                  <Trophy className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="font-medium text-foreground">Prizes: </span>
                    {content.prize}
                  </span>
                </li>
              ) : null}
              {content.hosts ? (
                <li className="flex items-start gap-2">
                  <Users className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="font-medium text-foreground">Judges: </span>
                    {content.hosts}
                  </span>
                </li>
              ) : null}
            </ul>
          ) : null}

          {schedule.length > 0 ? (
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
                <CalendarDays className="size-4 text-muted-foreground" />
                Schedule
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                {schedule.map((row, i) => (
                  <div key={`${row.label}-${i}`} className="contents">
                    <dt className="text-muted-foreground">{row.label}</dt>
                    <dd className="text-foreground">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {content.discordUrl ? (
            <Button className="pointer-events-none w-full">
              <ExternalLink className="size-4" />
              Read the full announcement
            </Button>
          ) : null}
          <p className="text-center text-xs italic text-muted-foreground">
            Unofficial community event
          </p>
        </div>
      </section>
    </div>
  );
}
