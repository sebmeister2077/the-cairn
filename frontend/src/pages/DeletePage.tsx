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
import { VS_WAYPOINT_ICONS } from "@/lib/vs-icons";

export function DeletePage() {
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
          `Deleted ${data.deleted} waypoint(s). ${data.remaining} remaining.`
        );
      } else {
        setResult(data.message ?? "No matching waypoints found.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
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
        <CardTitle>Delete Waypoints</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <FileUpload
            id="save"
            label="Save file (.vcdbs)"
            accept=".vcdbs"
            required
            onChange={setSaveFile}
          />
          <FileUpload
            id="config"
            label="Server config (optional)"
            accept=".json"
            onChange={setConfigFile}
          />
          <SaveFileHelp />
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label htmlFor="title">Title filter</Label>
              <Combobox id="title" value={title} onChange={setTitle} suggestions={[]} placeholder="e.g. trader" />
            </div>
            <div>
              <Label htmlFor="icon">Icon filter</Label>
              <Combobox id="icon" value={icon} onChange={setIcon} suggestions={VS_WAYPOINT_ICONS} placeholder="e.g. circle" />
            </div>
            <div>
              <Label htmlFor="owner">Owner filter<HelpTip text="The owner is the unique player ID stored with each waypoint. In singleplayer this is your player UID. Filter to delete only waypoints belonging to a specific player." /></Label>
              <Combobox id="owner" value={owner} onChange={setOwner} suggestions={[]} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 items-end">
            <div>
              <Label htmlFor="color">Color (#AARRGGBB)</Label>
              <Input id="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="guid">GUID<HelpTip text="The GUID is a unique identifier for each individual waypoint (e.g. 740f7877-971f-...). Use this to target a single specific waypoint for deletion." /></Label>
              <Input id="guid" value={guid} onChange={(e) => setGuid(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Switch id="pinned" checked={pinnedOnly} onCheckedChange={setPinnedOnly} />
                <Label htmlFor="pinned">Pinned only</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="unpinned" checked={unpinnedOnly} onCheckedChange={setUnpinnedOnly} />
                <Label htmlFor="unpinned">Unpinned only</Label>
              </div>
            </div>
          </div>
          <Button type="submit" disabled={!saveFile || loading} variant="destructive">
            {loading ? "Deleting…" : "Delete Matching"}
          </Button>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          {result && (
            <div className="space-y-2">
              <p className="text-sm text-green-600">{result}</p>
              {blob && (
                <Button variant="outline" size="sm" onClick={download}>
                  Download modified .vcdbs
                </Button>
              )}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
