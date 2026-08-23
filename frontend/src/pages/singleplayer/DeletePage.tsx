import { useState, type FormEvent } from "react";
import { deleteWaypoints } from "@/lib/api";
import { FileUpload } from "@/components/FileUpload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { HelpTip } from "@/components/ui/help-tip";
import { SaveFileHelp } from "@/components/SaveFileHelp";
import { SafetyNotice } from "@/components/SafetyNotice";
import { useTranslation } from "@/lib/i18n";
import { VS_WAYPOINT_ICONS } from "@/lib/vs-icons";

export function DeletePage() {
  const { t } = useTranslation();
  const [saveFile, setSaveFile] = useState<File | null>(null);
  const [configFile, setConfigFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState("");
  const [owner, setOwner] = useState("");
  const [color, setColor] = useState("");
  const [guid, setGuid] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [unpinnedOnly, setUnpinnedOnly] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!saveFile) return;
    setError("");
    setResult(null);
    setBlob(null);
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("save_file", saveFile);
      if (configFile) fd.append("config_file", configFile);
      if (title) fd.append("title", title);
      if (icon) fd.append("icon", icon);
      if (owner) fd.append("owner", owner);
      if (color) fd.append("color", color);
      if (guid) fd.append("guid", guid);
      fd.append("pinned_only", String(pinnedOnly));
      fd.append("unpinned_only", String(unpinnedOnly));
      const data = await deleteWaypoints(fd);
      if (data.modified) {
        setBlob(data.blob);
        setResult(
          t("deletePage.deleteResult", { deleted: data.deleted, remaining: data.remaining }),
        );
      } else {
        setResult(data.message ?? t("deletePage.noMatches"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.unknownError"));
    } finally {
      setLoading(false);
    }
  }

  function download() {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "modified.vcdbs";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("deletePage.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <SafetyNotice mode="modify" />
        <form onSubmit={handleSubmit} className="grid gap-4 mt-4">
          <FileUpload
            id="save"
            label={t("deletePage.saveFileLabel")}
            accept=".vcdbs"
            required
            onChange={setSaveFile}
          />
          <FileUpload
            id="config"
            label={t("deletePage.configFileLabel")}
            accept=".json"
            onChange={setConfigFile}
          />
          <SaveFileHelp />
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label htmlFor="title">{t("deletePage.titleFilter")}</Label>
              <Combobox
                id="title"
                value={title}
                onChange={setTitle}
                suggestions={[]}
                placeholder={t("deletePage.titlePlaceholder")}
              />
            </div>
            <div>
              <Label htmlFor="icon">{t("deletePage.iconFilter")}</Label>
              <Combobox
                id="icon"
                value={icon}
                onChange={setIcon}
                suggestions={VS_WAYPOINT_ICONS}
                placeholder={t("deletePage.iconPlaceholder")}
              />
            </div>
            <div>
              <Label htmlFor="owner">
                {t("deletePage.ownerFilter")}
                <HelpTip text={t("deletePage.ownerHelp")} />
              </Label>
              <Combobox id="owner" value={owner} onChange={setOwner} suggestions={[]} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 items-end">
            <div>
              <Label htmlFor="color">{t("deletePage.colorLabel")}</Label>
              <Input id="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="guid">
                {t("deletePage.guidLabel")}
                <HelpTip text={t("deletePage.guidHelp")} />
              </Label>
              <Input id="guid" value={guid} onChange={(e) => setGuid(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Switch id="pinned" checked={pinnedOnly} onCheckedChange={setPinnedOnly} />
                <Label htmlFor="pinned">{t("deletePage.pinnedOnly")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="unpinned" checked={unpinnedOnly} onCheckedChange={setUnpinnedOnly} />
                <Label htmlFor="unpinned">{t("deletePage.unpinnedOnly")}</Label>
              </div>
            </div>
          </div>
          <Button type="submit" disabled={!saveFile || loading} variant="destructive">
            {loading ? t("deletePage.deleting") : t("deletePage.deleteMatching")}
          </Button>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          {result && (
            <div className="space-y-2">
              <p className="text-sm text-green-600">{result}</p>
              {blob && (
                <Button variant="outline" size="sm" onClick={download}>
                  {t("deletePage.downloadModified")}
                </Button>
              )}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
