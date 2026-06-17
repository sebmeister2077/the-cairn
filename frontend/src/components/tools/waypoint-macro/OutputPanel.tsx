// Shared output panel: macro metadata, command preview, and download.

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Download } from "lucide-react";
import { downloadMacro, macroFileName, type MacroMeta } from "@/lib/waypoint-macro";

interface OutputPanelProps {
  commands: string[];
  meta: MacroMeta;
  onMetaChange: (meta: MacroMeta) => void;
}

export function OutputPanel({ commands, meta, onMetaChange }: OutputPanelProps) {
  const canDownload = meta.name.trim().length > 0 && commands.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Macro output</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-[1fr_7rem] gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="macro-name">Macro name</Label>
            <Input
              id="macro-name"
              value={meta.name}
              placeholder="My waypoints"
              onChange={(e) => onMetaChange({ ...meta, name: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="macro-index">Index</Label>
            <Input
              id="macro-index"
              type="number"
              min={0}
              value={Number.isFinite(meta.index) ? meta.index : 0}
              onChange={(e) =>
                onMetaChange({ ...meta, index: Math.max(0, Math.floor(Number(e.target.value))) })
              }
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Saves as <code className="rounded bg-muted px-1 py-0.5">{macroFileName(meta)}</code> —
          place it in <code className="rounded bg-muted px-1 py-0.5">VintagestoryData/Macros/</code>
          .
        </p>

        <div className="grid gap-1.5">
          <div className="flex items-center justify-between">
            <Label>Commands</Label>
            <span className="text-xs text-muted-foreground">{commands.length} total</span>
          </div>
          <div className="max-h-72 overflow-auto rounded-lg border border-border bg-muted/40 p-2">
            {commands.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No commands yet — configure the options above.
              </p>
            ) : (
              <ol className="space-y-0.5 font-mono text-xs">
                {commands.slice(0, 1000).map((cmd, i) => (
                  <li key={i} className="whitespace-pre-wrap break-all">
                    <span className="mr-2 select-none text-muted-foreground">{i + 1}.</span>
                    {cmd}
                  </li>
                ))}
                {commands.length > 1000 && (
                  <li className="text-muted-foreground">+ {commands.length - 1000} more…</li>
                )}
              </ol>
            )}
          </div>
        </div>

        <Button type="button" disabled={!canDownload} onClick={() => downloadMacro(meta, commands)}>
          <Download className="size-4" /> Download .json
        </Button>
      </CardContent>
    </Card>
  );
}
