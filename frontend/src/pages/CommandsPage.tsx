import { useState, type FormEvent } from "react";
import { generateCommands } from "@/lib/api";
import { FileUpload } from "@/components/FileUpload";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SaveFileHelp } from "@/components/SaveFileHelp";
import { VS_WAYPOINT_ICONS } from "@/lib/vs-icons";

export function CommandsPage() {
  const [saveFile, setSaveFile] = useState<File | null>(null);
  const [wpFile, setWpFile] = useState<File | null>(null);
  const [configFile, setConfigFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState("");
  const [commands, setCommands] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!saveFile && !wpFile) return;
    setError("");
    setLoading(true);
    try {
      const fd = new FormData();
      if (saveFile) fd.append("save_file", saveFile);
      if (wpFile) fd.append("waypoints_file", wpFile);
      if (configFile) fd.append("config_file", configFile);
      if (title) fd.append("title", title);
      if (icon) fd.append("icon", icon);
      const data = await generateCommands(fd);
      setCommands(data.commands);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  function copyAll() {
    navigator.clipboard.writeText(commands.join("\n"));
  }

  function downloadTxt() {
    const blob = new Blob([commands.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "waypoint_commands.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generate Commands</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <FileUpload
            id="save"
            label="Save file (.vcdbs)"
            accept=".vcdbs"
            onChange={setSaveFile}
          />
          <FileUpload
            id="wp"
            label="— or — Waypoints JSON"
            accept=".json"
            onChange={setWpFile}
          />
          <FileUpload
            id="config"
            label="Server config (optional)"
            accept=".json"
            onChange={setConfigFile}
          />
          <SaveFileHelp />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="title">Title filter</Label>
              <Combobox id="title" value={title} onChange={setTitle} suggestions={[]} placeholder="e.g. trader" />
            </div>
            <div>
              <Label htmlFor="icon">Icon filter</Label>
              <Combobox id="icon" value={icon} onChange={setIcon} suggestions={VS_WAYPOINT_ICONS} placeholder="e.g. circle" />
            </div>
          </div>
          <Button type="submit" disabled={(!saveFile && !wpFile) || loading}>
            {loading ? "Generating…" : "Generate"}
          </Button>
          {error && <p className="text-red-500 text-sm">{error}</p>}
        </form>

        {commands.length > 0 && (
          <div className="mt-6 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {commands.length} command(s)
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={copyAll}>
                  Copy all
                </Button>
                <Button variant="outline" size="sm" onClick={downloadTxt}>
                  Download .txt
                </Button>
              </div>
            </div>
            <pre className="bg-muted rounded-md p-3 text-xs overflow-auto max-h-[400px] whitespace-pre-wrap">
              {commands.join("\n")}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
