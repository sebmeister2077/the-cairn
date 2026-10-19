import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarDays, ExternalLink, Hammer, MapPin, Trophy, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { dismissPromo, markPromoDetailsOpened } from "@/store/slices/promo";
import { recordPromoEvent } from "@/lib/helpers/promo-analytics";
import { useActivePromo } from "@/hooks/useActivePromo";
import { promoImageSrc, type PromoEvent } from "@/lib/helpers/api";

// --- Time-limited event promo ------------------------------------------------
// The banner is now fully admin-driven: an active promotion is fetched from the
// backend (see `useActivePromo`) and its rich content rendered below. Admins
// (and holders of the `manage_promos` permission) create / activate / expire
// promos from the "Promos" management page.

// One impression per browser session (not per page load), so refreshing while
// ignoring the banner doesn't inflate the count. `distinct visitors` in the
// admin dashboard still reflects true unique reach.
function shouldCountImpression(impressionSessionKey: string): boolean {
  try {
    if (window.sessionStorage.getItem(impressionSessionKey) === "1") return false;
    window.sessionStorage.setItem(impressionSessionKey, "1");
    return true;
  } catch {
    // No sessionStorage (private mode / blocked): fall back to counting once
    // per page load rather than dropping impressions entirely.
    return true;
  }
}

/**
 * Slim, dismissible site-wide banner for the currently-active community event.
 *
 * Renders nothing when there is no active promo, once the event has expired, or
 * after the visitor dismisses it (remembered per-browser via localStorage, keyed
 * by promo id). A "Details" button opens a dialog with the poster, rules summary,
 * prize, schedule, registration spot and a link to the official announcement.
 */
export function EventPromoBanner() {
  const promo = useActivePromo();
  if (!promo) return null;
  // Defensive client-side expiry check (the backend already filters expired
  // promos, but a locally-cached one could tick past its deadline between
  // refetches). Keyed on the promo so the inner component resets cleanly when
  // the active promo changes.
  const expired = promo.expires_at != null && Date.now() >= Date.parse(promo.expires_at);
  if (expired) return null;
  return <PromoBanner key={promo.id} promo={promo} />;
}

function PromoBanner({ promo }: { promo: PromoEvent }) {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const dismissed = useAppSelector((s) => s.promo.dismissed?.[promo.id] ?? false);
  // Persisted so the "dismissed after reading" split survives a refresh
  // between opening the details and dismissing the banner.
  const detailsOpened = useAppSelector((s) => s.promo.detailsOpened?.[promo.id] ?? false);
  const [open, setOpen] = useState(false);
  const impressionSentRef = useRef(false);

  const content = promo.content ?? {};
  const imageSrc = promoImageSrc(promo);
  const schedule = content.schedule ?? [];

  // Count one impression per browser session while the banner is visible.
  useEffect(() => {
    if (dismissed || impressionSentRef.current) return;
    impressionSentRef.current = true;
    if (shouldCountImpression(`promo-impression:${promo.id}`)) {
      recordPromoEvent("impression", promo.id);
    }
  }, [dismissed, promo.id]);

  if (dismissed) return null;

  function openDetails() {
    dispatch(markPromoDetailsOpened(promo.id));
    setOpen(true);
    recordPromoEvent("details_open", promo.id);
  }

  function dismiss() {
    recordPromoEvent("dismiss", promo.id, { afterDetails: detailsOpened });
    dispatch(dismissPromo(promo.id));
  }

  return (
    <>
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
        <Hammer className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <span className="font-medium">{promo.title}</span>
          {content.subtitle ? (
            <span className="hidden sm:inline text-amber-800 dark:text-amber-200/90">
              {" "}
              {content.subtitle}
            </span>
          ) : null}
        </div>
        <Button size="xs" variant="secondary" className="shrink-0" onClick={openDetails}>
          Details
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          className="shrink-0"
          aria-label="Dismiss announcement"
          onClick={dismiss}
        >
          <X />
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Hammer className="size-5 text-amber-600 dark:text-amber-400" />
              {promo.title}
            </DialogTitle>
            {content.hostedBy || content.hosts ? (
              <DialogDescription>
                {content.hostedBy ? `Hosted at ${content.hostedBy}` : "Hosted"}
                {content.hosts ? ` by ${content.hosts}` : ""}.
              </DialogDescription>
            ) : null}
          </DialogHeader>

          {imageSrc ? (
            <img
              src={imageSrc}
              alt={promo.title}
              className="w-full rounded-lg border border-border"
              loading="lazy"
            />
          ) : null}

          {content.summary ? (
            <p className="text-sm text-foreground">{content.summary}</p>
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
                      <button
                        type="button"
                        className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
                        onClick={() => {
                          recordPromoEvent("map_click", promo.id);
                          setOpen(false);
                          navigate(content.mapUrl!);
                        }}
                      >
                        Show on map
                      </button>
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
            <Button
              className="w-full"
              render={
                <a
                  href={content.discordUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => recordPromoEvent("announcement_click", promo.id)}
                >
                  <ExternalLink className="size-4" />
                  Read the full announcement
                </a>
              }
            />
          ) : null}
          <p className="text-center text-xs italic text-muted-foreground">
            Unofficial community event
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
