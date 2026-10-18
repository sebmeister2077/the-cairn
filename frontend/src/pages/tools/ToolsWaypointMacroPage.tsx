// Waypoint Macro Generator tool.
//
// Three input modes (upload chat log, import map data, generate from scratch)
// each produce a list of `/waypoint` chat commands, which are assembled into a
// downloadable Vintage Story macro file (`{index}-{Name}.json`).

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTranslation } from "@/lib/i18n";
import type { MacroMeta } from "@/lib/waypoints/waypoint-macro";
import { UploadMode } from "@/components/tools/waypoint-macro/UploadMode";
import { ImportMode } from "@/components/tools/waypoint-macro/ImportMode";
import { ScratchMode } from "@/components/tools/waypoint-macro/ScratchMode";
import { DedupMode } from "@/components/tools/waypoint-macro/DedupMode";
import { OutputPanel } from "@/components/tools/waypoint-macro/OutputPanel";
import { MaintenanceChip } from "@/components/other/MaintenanceChip";

type Mode = "upload" | "import" | "scratch" | "dedup";

export function ToolsWaypointMacroPage() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("upload");
  // Commands are owned per active mode; switching modes resets them so the
  // output panel always reflects the visible mode.
  const [commands, setCommands] = useState<string[]>([]);
  const [meta, setMeta] = useState<MacroMeta>({ index: 0, name: "Waypoints" });

  function switchMode(next: Mode) {
    if (next === mode) return;
    setCommands([]);
    setMode(next);
  }

  return (
    <div className="mx-auto max-w-12xl space-y-6 px-4 ">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold">{t("tools.waypointMacro.pageTitle")}</h1>
          <MaintenanceChip component="tools_waypoint_macro" />
        </div>
        <p className="text-sm text-muted-foreground">{t("tools.waypointMacro.pageDescription")}</p>
      </header>

      <Tabs value={mode} onValueChange={(v) => v && switchMode(v as Mode)}>
        <TabsList variant="line">
          <TabsTrigger value="upload">{t("tools.waypointMacro.tabs.upload")}</TabsTrigger>
          <TabsTrigger value="import">{t("tools.waypointMacro.tabs.import")}</TabsTrigger>
          <TabsTrigger value="dedup">{t("tools.waypointMacro.tabs.dedup")}</TabsTrigger>
          <TabsTrigger value="scratch">{t("tools.waypointMacro.tabs.scratch")}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <div>
          {mode === "upload" && <UploadMode onCommandsChange={setCommands} />}
          {mode === "import" && <ImportMode onCommandsChange={setCommands} />}
          {mode === "dedup" && <DedupMode onCommandsChange={setCommands} />}
          {mode === "scratch" && <ScratchMode onCommandsChange={setCommands} />}
        </div>
        <div className="lg:sticky lg:top-4 lg:self-start">
          <OutputPanel commands={commands} meta={meta} onMetaChange={setMeta} />
        </div>
      </div>
    </div>
  );
}
