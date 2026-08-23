import { useState, useMemo, type FormEvent } from "react";
import { extractWaypoints } from "@/lib/api";
import { FileUpload } from "@/components/FileUpload";
import { WaypointTable } from "@/components/WaypointTable";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HelpTip } from "@/components/ui/help-tip";
import { SaveFileHelp } from "@/components/SaveFileHelp";
import { SafetyNotice } from "@/components/SafetyNotice";
import { useTranslation } from "@/lib/i18n";
import { VS_WAYPOINT_ICONS } from "@/lib/vs-icons";

export function ExtractPage() {
  const { t } = useTranslation();
  const [saveFile, setSaveFile] = useState<File | null>(null);
  const [configFile, setConfigFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState("");
  const [owner, setOwner] = useState("");
  const [waypoints, setWaypoints] = useState<unknown[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const titleSuggestions = useMemo(
    () => [
      ...new Set(
        (waypoints as { title?: string }[]).map((w) => w.title).filter(Boolean) as string[],
      ),
    ],
    [waypoints],
  );
  const ownerSuggestions = useMemo(
    () => [
      ...new Set(
        (waypoints as { owner?: string }[]).map((w) => w.owner).filter(Boolean) as string[],
      ),
    ],
    [waypoints],
  );
  const iconSuggestions = useMemo(() => {
    const fromData = (waypoints as { icon?: string }[])
      .map((w) => w.icon)
      .filter(Boolean) as string[];
    return [...new Set([...VS_WAYPOINT_ICONS, ...fromData])];
  }, [waypoints]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!saveFile) return;
    setError("");
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("save_file", saveFile);
      if (configFile) fd.append("config_file", configFile);
      if (title) fd.append("title", title);
      if (icon) fd.append("icon", icon);
      if (owner) fd.append("owner", owner);
      const data = await extractWaypoints(fd);
      setWaypoints(data.waypoints);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.unknownError"));
    } finally {
      setLoading(false);
    }
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify(waypoints, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "waypoints.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("extractPage.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <SafetyNotice mode="read" />
        <form onSubmit={handleSubmit} className="grid gap-4 mt-4">
          <FileUpload
            id="save"
            label={t("extractPage.saveFileLabel")}
            accept=".vcdbs"
            required
            onChange={setSaveFile}
          />
          <FileUpload
            id="config"
            label={t("extractPage.configFileLabel")}
            accept=".json"
            onChange={setConfigFile}
          />
          <SaveFileHelp />
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label htmlFor="title">{t("extractPage.titleFilter")}</Label>
              <Combobox
                id="title"
                value={title}
                onChange={setTitle}
                suggestions={titleSuggestions}
                placeholder={t("extractPage.titlePlaceholder")}
              />
            </div>
            <div>
              <Label htmlFor="icon">{t("extractPage.iconFilter")}</Label>
              <Combobox
                id="icon"
                value={icon}
                onChange={setIcon}
                suggestions={iconSuggestions}
                placeholder={t("extractPage.iconPlaceholder")}
              />
            </div>
            <div>
              <Label htmlFor="owner">
                {t("extractPage.ownerFilter")}
                <HelpTip text={t("extractPage.ownerHelp")} />
              </Label>
              <Combobox
                id="owner"
                value={owner}
                onChange={setOwner}
                suggestions={ownerSuggestions}
              />
            </div>
          </div>
          <Button type="submit" disabled={!saveFile || loading}>
            {loading ? t("extractPage.extracting") : t("extractPage.extract")}
          </Button>
          {error && <p className="text-red-500 text-sm">{error}</p>}
        </form>

        {waypoints.length > 0 && (
          <div className="mt-6 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {t("extractPage.waypointsFound", { count: waypoints.length })}
              </p>
              <Button variant="outline" size="sm" onClick={downloadJson}>
                {t("extractPage.downloadJson")}
              </Button>
            </div>
            <WaypointTable waypoints={waypoints as never[]} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
