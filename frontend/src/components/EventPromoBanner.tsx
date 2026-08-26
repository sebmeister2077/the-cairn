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
import { recordPromoEvent } from "@/lib/promo-analytics";
import chiselCompetitionImg from "@/assets/Promotions/chisel_competition.png";

// --- Time-limited event promo ------------------------------------------------
// This is intentionally self-contained: a single component with the event data
// inline so it can be dropped in and later deleted without touching i18n or
// backend config. When the event is over, either delete this file + its mount
// in AppContent, or bump PROMO to the next event.

const PROMO = {
  id: "tops-chisel-competition-2026-09",
  title: "TOPS Chisel Competition",
  // The banner (and its dialog) stop rendering after this moment. Registration
  // closes Sep 1, 2026 7:00 AM, so the promo auto-removes itself then.
  endsAt: new Date("2026-09-01T07:00:00"),
  image: chiselCompetitionImg,
  hosts: "Yoma22k, Nudge & DuStPaInFuL",
  hostedBy: "The Community Centre",
  discordUrl:
    "https://discord.com/channels/302152934249070593/1369341219737436200/1541603219661258843",
  registration: "White building on West Road at -1390, -20 (between Perch Point and Sandwich)",
  // Deep-link into the TOPS map viewer centered on the registration building.
  // (`zoom` is pixels-per-block; ~4 frames the surrounding blocks nicely.)
  mapUrl: "/multiplayer/tops-map?x=-1390&z=-20&zoom=4",
  summary:
    "The first TOPS chiseling event! Build a piece of chisel art between 2×2×2 and 4×4×4 using any blocks in the game. No theme this round — just be creative.",
  prize:
    "Prize pool by placement — 1st ~5k, 2nd ~3.5k, 3rd ~2.5k (rusty-gear net worth) in clothes, clutter, RG, armor, ingots & gold. Extra RG donations are split among the remaining entries.",
  schedule: [
    { label: "Registration", value: "Aug 25 – Sep 1, 2026" },
    { label: "Chiseling", value: "Sep 1 – Sep 26, 2026" },
    { label: "Voting", value: "Sep 26 – Sep 30, 2026" },
    { label: "Winners announced", value: "Oct 1, 2026" },
  ],
} as const;

// One impression per browser session (not per page load), so refreshing while
// ignoring the banner doesn't inflate the count. `distinct visitors` in the
// admin dashboard still reflects true unique reach.
const impressionSessionKey = `promo-impression:${PROMO.id}`;

function shouldCountImpression(): boolean {
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
 * Slim, dismissible site-wide banner for a time-limited community event.
 *
 * Renders nothing once the event has ended (``PROMO.endsAt``) or after the
 * visitor dismisses it (remembered per-browser via localStorage). The banner
 * itself stays out of the way; a "Details" button opens a dialog with the
 * poster, rules summary, prize, schedule, registration spot and a link to the
 * official Discord announcement.
 */
export function EventPromoBanner() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const dismissed = useAppSelector((s) => s.promo.dismissed?.[PROMO.id] ?? false);
  // Persisted so the "dismissed after reading" split survives a refresh
  // between opening the details and dismissing the banner.
  const detailsOpened = useAppSelector((s) => s.promo.detailsOpened?.[PROMO.id] ?? false);
  const [open, setOpen] = useState(false);
  const impressionSentRef = useRef(false);

  const expired = Date.now() >= PROMO.endsAt.getTime();

  // Count one impression per browser session while the banner is visible.
  useEffect(() => {
    if (expired || dismissed || impressionSentRef.current) return;
    impressionSentRef.current = true;
    if (shouldCountImpression()) recordPromoEvent("impression", PROMO.id);
  }, [expired, dismissed]);

  if (expired || dismissed) return null;

  function openDetails() {
    dispatch(markPromoDetailsOpened(PROMO.id));
    setOpen(true);
    recordPromoEvent("details_open", PROMO.id);
  }

  function dismiss() {
    recordPromoEvent("dismiss", PROMO.id, { afterDetails: detailsOpened });
    dispatch(dismissPromo(PROMO.id));
  }

  return (
    <>
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
        <Hammer className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <span className="font-medium">{PROMO.title}</span>
          <span className="hidden sm:inline text-amber-800 dark:text-amber-200/90">
            {" "}
            — a TOPS community event. Register by Sep 1.
          </span>
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
              {PROMO.title}
            </DialogTitle>
            <DialogDescription>
              Hosted at {PROMO.hostedBy} by {PROMO.hosts}.
            </DialogDescription>
          </DialogHeader>

          <img
            src={PROMO.image}
            alt="The Community Centre — Chisel Competition"
            className="w-full rounded-lg border border-border"
            loading="lazy"
          />

          <p className="text-sm text-foreground">{PROMO.summary}</p>

          <ul className="space-y-2 text-sm">
            <li className="flex items-start gap-2">
              <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="font-medium text-foreground">Register &amp; rules: </span>
                {PROMO.registration}{" "}
                <button
                  type="button"
                  className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
                  onClick={() => {
                    recordPromoEvent("map_click", PROMO.id);
                    setOpen(false);
                    navigate(PROMO.mapUrl);
                  }}
                >
                  Show on map
                </button>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Trophy className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="font-medium text-foreground">Prizes: </span>
                {PROMO.prize}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Users className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="font-medium text-foreground">Judges: </span>
                {PROMO.hosts}
              </span>
            </li>
          </ul>

          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
              <CalendarDays className="size-4 text-muted-foreground" />
              Schedule
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {PROMO.schedule.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="text-foreground">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <Button
            className="w-full"
            render={
              <a
                href={PROMO.discordUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => recordPromoEvent("announcement_click", PROMO.id)}
              >
                <ExternalLink className="size-4" />
                Read the full announcement on Discord
              </a>
            }
          />
          <p className="text-center text-xs italic text-muted-foreground">
            Unofficial community event — not affiliated with Anego Studios.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
