import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { clearPersistedQueryCache } from "@/lib/api";
import { getStoredConsent, setStoredConsent, type ConsentValue } from "@/lib/consent";

interface CookieConsentProps {
  /**
   * If true, render as a blocking modal (used when an invite link is being
   * claimed and we MUST get consent before storing the API key).
   * If false, render as a dismissible banner pinned to the bottom.
   */
  blocking?: boolean;
  onChange?: (value: ConsentValue) => void;
}

export function CookieConsent({ blocking = false, onChange }: CookieConsentProps) {
  const [consent, setConsent] = useState<ConsentValue | null>(getStoredConsent);
  // Set when the user reopens the banner from the footer to review/change a
  // choice they already made. Kept separate from `consent` so reopening never
  // silently revokes the existing decision.
  const [reopened, setReopened] = useState(false);

  useEffect(() => {
    function handleChange(e: Event) {
      const detail = (e as CustomEvent<ConsentValue>).detail;
      setConsent(detail ?? getStoredConsent());
    }
    function handleReopen() {
      setReopened(true);
    }
    window.addEventListener("storage-consent-change", handleChange);
    window.addEventListener("storage", () => setConsent(getStoredConsent()));
    window.addEventListener("open-cookie-settings", handleReopen);
    return () => {
      window.removeEventListener("storage-consent-change", handleChange);
      window.removeEventListener("open-cookie-settings", handleReopen);
    };
  }, []);

  // Show on first visit (no decision yet) or when explicitly reopened.
  if (consent !== null && !reopened) return null;

  function decide(value: ConsentValue) {
    if (value === "declined") {
      // Declining keeps the bare minimum needed to run the service —
      // the API key (rate limiting is tied to it) and this consent
      // choice. Everything else must not persist, so drop any cached
      // query data written during this session. The Redux envelope is
      // rewritten to its api-key-only form on the next store change.
      clearPersistedQueryCache();
    }
    setStoredConsent(value);
    setConsent(value);
    setReopened(false);
    onChange?.(value);
  }

  const body = (
    <Card className="w-full max-w-xl shadow-lg">
      <CardContent className="space-y-3 p-5 text-sm">
        <p className="font-medium text-foreground">This site stores data in your browser</p>
        <p className="text-muted-foreground">
          We use your browser's local storage (not third-party tracking cookies) to keep you signed
          in, remember UI preferences such as the last-viewed map level, and cache map data so the
          app loads faster. We do not use third-party tracking, advertising, or analytics cookies
          (no Google Analytics, no pixels); we only keep a first-party usage log on our own backend
          to run the service.
        </p>
        <p className="text-muted-foreground">
          By clicking <strong>Accept</strong> you agree to our{" "}
          <a href="/terms" className="underline hover:text-foreground">
            Terms of Use
          </a>{" "}
          and{" "}
          <a href="/privacy" className="underline hover:text-foreground">
            Privacy Policy
          </a>
          . If you decline, we keep only your API key (needed for rate limiting) and won't store
          anything else, so features that rely on saved data — like TL groupings — stay unavailable.
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {reopened && consent !== null && (
            <Button variant="ghost" size="sm" onClick={() => setReopened(false)}>
              Cancel
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => decide("declined")}>
            Decline
          </Button>
          <Button size="sm" onClick={() => decide("accepted")}>
            Accept
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  if (blocking) {
    return (
      <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4">
        {body}
      </div>
    );
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-4 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-xl">{body}</div>
    </div>
  );
}
