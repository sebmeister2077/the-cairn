import type { UserFlag } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function FlagRow({
  flag,
  onResolve,
  pending,
}: {
  flag: UserFlag;
  onResolve?: (resolution: "valid" | "abuse" | "dismissed") => void;
  pending?: boolean;
}) {
  return (
    <div className="border rounded p-2 text-sm space-y-1 min-w-0 overflow-hidden">
      <div className="flex items-center justify-between gap-2 flex-wrap min-w-0">
        <Badge variant={flag.resolved_at ? "outline" : "destructive"} className="break-all">
          {flag.reason}
        </Badge>
        <span className="text-xs text-muted-foreground break-all">
          {new Date(flag.created_at).toLocaleString()}
        </span>
      </div>
      {flag.related_display_name && (
        <div className="text-xs text-muted-foreground break-all">
          Related to: <span className="font-mono">{flag.related_display_name}</span>
        </div>
      )}
      {flag.metadata && Object.keys(flag.metadata).length > 0 && (
        <pre className="text-[10px] bg-muted/50 rounded p-1 max-w-full overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify(flag.metadata, null, 2)}
        </pre>
      )}
      {flag.resolved_at ? (
        <div className="text-xs text-muted-foreground">
          Resolved {new Date(flag.resolved_at).toLocaleString()}
          {flag.resolution && (
            <>
              {" "}
              as <strong>{flag.resolution}</strong>
            </>
          )}
        </div>
      ) : (
        onResolve && (
          <div className="flex gap-1 pt-1">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onResolve("valid")}
            >
              Valid
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onResolve("abuse")}
            >
              False positive
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onResolve("dismissed")}
            >
              Dismiss
            </Button>
          </div>
        )
      )}
    </div>
  );
}
