import { Button } from "@/components/ui/button";
import { Card, CardContent } from "./ui/card";

export function AuthRejectedBanner({
  kind,
  hasDefaultInvite,
  onDismiss,
  onClaim,
  onOpenApiKey,
  onReopenConsent,
}: {
  kind: "had-key" | "no-key" | "no-key-no-consent";
  hasDefaultInvite: boolean;
  onDismiss: () => void;
  onClaim: () => void;
  onOpenApiKey: () => void;
  onReopenConsent: () => void;
}) {
  let title: string;
  let body: string;
  let primary: { label: string; onClick: () => void } | null = null;

  if (kind === "had-key") {
    title = "Your access has been restricted";
    body =
      "The server rejected your access key. It may have been revoked or temporarily disabled by an admin, or your account may have been removed. You can paste a different key, or contact an administrator if you think this is a mistake.";
    primary = { label: "Use a different key", onClick: onOpenApiKey };
  } else if (kind === "no-key-no-consent") {
    title = "Almost there — one quick thing";
    body =
      "To set you up we need to store a small amount of data in your browser. Review the cookie prompt and accept storage to continue — it's free, no sign-up needed.";
    primary = { label: "Review cookie prompt", onClick: onReopenConsent };
  } else {
    title = hasDefaultInvite ? "Let's get you back in" : "You need an access key to continue";
    body = hasDefaultInvite
      ? "Your previous session was rejected. We can set you up again instantly — no sign-up, no email, no payment."
      : "Your previous session was rejected. Paste an access key to continue, or ask an admin for an invite link.";
    primary = hasDefaultInvite
      ? { label: "Get started", onClick: onClaim }
      : { label: "Enter an access key", onClick: onOpenApiKey };
  }

  return (
    <Card className="mb-4 border-amber-300 bg-amber-50/70 dark:bg-amber-950/30">
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="font-medium text-foreground">{title}</p>
          <p className="text-sm text-muted-foreground">{body}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
          {primary && (
            <Button size="sm" onClick={primary.onClick}>
              {primary.label}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
