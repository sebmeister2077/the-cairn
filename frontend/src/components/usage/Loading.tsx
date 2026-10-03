import { Loader2 } from "lucide-react";

export function Loading() {
  return (
    <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </div>
  );
}
