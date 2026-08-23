import { useState, type FormEvent } from "react";
import { importWaypoints } from "@/lib/api";
import { FileUpload } from "@/components/FileUpload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { HelpTip } from "@/components/ui/help-tip";
import { SaveFileHelp } from "@/components/SaveFileHelp";
import { SafetyNotice } from "@/components/SafetyNotice";
import { useTranslation } from "@/lib/i18n";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ImportPage() {
  const { t } = useTranslation();
  const [saveFile, setSaveFile] = useState<File | null>(null);
  const [wpFile, setWpFile] = useState<File | null>(null);
  const [configFile, setConfigFile] = useState<File | null>(null);
  const [mode, setMode] = useState("append");
  const [owner, setOwner] = useState("");
  const [newGuids, setNewGuids] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [blob, setBlob] = useState<Blob | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!saveFile || !wpFile) return;
    setError("");
    setResult(null);
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("save_file", saveFile);
      fd.append("waypoints_file", wpFile);
      if (configFile) fd.append("config_file", configFile);
      fd.append("mode", mode);
      if (owner) fd.append("owner", owner);
      fd.append("new_guids", String(newGuids));
      const data = await importWaypoints(fd);
      setBlob(data.blob);
      setResult(
        t("importPage.importedResult", { imported: data.imported, existing: data.existing }),
      );
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
        <CardTitle>{t("importPage.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <SafetyNotice mode="modify" />
        <form onSubmit={handleSubmit} className="grid gap-4 mt-4">
          <FileUpload
            id="save"
            label={t("importPage.saveFileLabel")}
            accept=".vcdbs"
            required
            onChange={setSaveFile}
          />
          <FileUpload
            id="wp"
            label={t("importPage.waypointsJsonLabel")}
            accept=".json"
            required
            onChange={setWpFile}
          />
          <FileUpload
            id="config"
            label={t("importPage.configFileLabel")}
            accept=".json"
            onChange={setConfigFile}
          />
          <SaveFileHelp />
          <div className="grid grid-cols-3 gap-2 items-end">
            <div>
              <Label>{t("importPage.mode")}</Label>
              <Select value={mode} onValueChange={(v) => v !== null && setMode(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="append">{t("importPage.modeAppend")}</SelectItem>
                  <SelectItem value="replace">{t("importPage.modeReplace")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="owner">
                {t("importPage.ownerUidOptional")}
                <HelpTip text={t("importPage.ownerHelp")} />
              </Label>
              <Input id="owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="guids" checked={newGuids} onCheckedChange={setNewGuids} />
              <Label htmlFor="guids">
                {t("importPage.newGuids")}
                <HelpTip text={t("importPage.newGuidsHelp")} />
              </Label>
            </div>
          </div>
          <Button type="submit" disabled={!saveFile || !wpFile || loading}>
            {loading ? t("importPage.importing") : t("importPage.import")}
          </Button>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          {result && (
            <div className="space-y-2">
              <p className="text-sm text-green-600">{result}</p>
              <Button variant="outline" size="sm" onClick={download}>
                {t("importPage.downloadModified")}
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
