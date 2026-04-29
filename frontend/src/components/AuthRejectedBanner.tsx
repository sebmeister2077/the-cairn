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
      "The server rejected your API key. It may have been revoked or temporarily disabled by an admin, or your account may have been removed. You can paste a different key, or contact an administrator if you think this is a mistake.";
    primary = { label: "Use a different key", onClick: onOpenApiKey };
  } else if (kind === "no-key-no-consent") {
    title = "You need an API key to continue";
    body =
      "To use this service you'll need an API key, which means we have to store a small amount of data in your browser. Click below to review the cookie prompt again and accept storage so you can claim a free key.";
    primary = { label: "Review cookie prompt", onClick: onReopenConsent };
  } else {
    title = "You need an API key to continue";
    body = hasDefaultInvite
      ? "Your previous session was rejected. You can claim a free key now to keep going — no sign-up form, no email required."
      : "Your previous session was rejected. Paste an API key to continue, or ask an admin for an invite link.";
    primary = hasDefaultInvite
      ? { label: "Claim a key", onClick: onClaim }
      : { label: "Enter an API key", onClick: onOpenApiKey };
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
