// --------------------------------------------------------------------------- //
// Loading skeleton — mirrors the page layout (header, controls, totals,
// highlights, screener) so the transition into loaded content is stable.

import { Skeleton } from "@/components/ui/skeleton";

// --------------------------------------------------------------------------- //
export function MarketInsightsSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true">
      {/* Header */}
      <div className="space-y-2">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-3 w-full max-w-2xl" />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-56" />
      </div>

      {/* Window totals */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>

      {/* Highlights */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-44 w-full" />
        ))}
      </div>

      {/* Screener */}
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-112 w-full" />
      </div>
    </div>
  );
}
