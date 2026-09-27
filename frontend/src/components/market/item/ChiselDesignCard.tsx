import { Suspense } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import ChiseledBlockViewer from "@/components/market/ChiseledBlockViewer";
import { chiselColor } from "@/components/market/chiselColors";
import type { ChiselDesign } from "@/models/auction";

interface ChiselDesignCardProps {
  chiselDesign: ChiselDesign;
  chiselDescription?: string | null;
}

export function ChiselDesignCard({ chiselDesign, chiselDescription }: ChiselDesignCardProps) {
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <Suspense
          fallback={
            <div className="flex h-72 items-center justify-center gap-2 rounded-md border bg-muted/30 text-sm text-muted-foreground">
              <Spinner /> Loading 3D preview…
            </div>
          }
        >
          <ChiseledBlockViewer design={chiselDesign} />
        </Suspense>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Drag to rotate · scroll to zoom</span>
          {chiselDesign.materials.length > 0 && (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>Materials:</span>
              {Array.from(new Set(chiselDesign.materials)).map((code) => (
                <span key={code} className="inline-flex items-center gap-1">
                  <span
                    className="inline-block size-3 rounded-sm border"
                    style={{ background: chiselColor(code) }}
                  />
                  {code}
                </span>
              ))}
            </span>
          )}
        </div>
        {chiselDescription && (
          <p className="whitespace-pre-line text-sm text-muted-foreground">{chiselDescription}</p>
        )}
        <p className="text-xs text-muted-foreground">
          Rendered from the block&apos;s chisel data. Colours approximate each material — the exact
          in-game textures aren&apos;t available here.
        </p>
      </CardContent>
    </Card>
  );
}
