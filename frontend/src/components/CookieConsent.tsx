import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
    getStoredConsent,
    setStoredConsent,
    type ConsentValue,
} from "@/lib/consent";

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

    useEffect(() => {
        function handleChange(e: Event) {
            const detail = (e as CustomEvent<ConsentValue>).detail;
            setConsent(detail ?? getStoredConsent());
        }
        window.addEventListener("storage-consent-change", handleChange);
        window.addEventListener("storage", () => setConsent(getStoredConsent()));
        return () => {
            window.removeEventListener("storage-consent-change", handleChange);
        };
    }, []);

    if (consent !== null) return null;

    function decide(value: ConsentValue) {
        setStoredConsent(value);
        setConsent(value);
        onChange?.(value);
    }

    const body = (
        <Card className="w-full max-w-xl shadow-lg">
            <CardContent className="space-y-3 p-5 text-sm">
                <p className="font-medium text-foreground">
                    This site stores data in your browser
                </p>
                <p className="text-muted-foreground">
                    We use your browser's local storage (not third-party tracking
                    cookies) to keep you signed in with your API key, remember
                    UI preferences such as the last-viewed map level, and cache
                    map data so the app works offline-friendly. We do not use
                    advertising or analytics cookies.
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
                    . If you decline, the app will not store your API key and
                    most features will be unavailable.
                </p>
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => decide("declined")}
                    >
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
