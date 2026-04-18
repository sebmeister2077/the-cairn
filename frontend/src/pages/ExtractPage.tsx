import { useState, type FormEvent } from "react";
import { extractWaypoints } from "@/lib/api";
import { FileUpload } from "@/components/FileUpload";
import { WaypointTable } from "@/components/WaypointTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ExtractPage() {
  const [saveFile, setSaveFile] = useState<File | null>(null);
  const [configFile, setConfigFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState("");
  const [owner, setOwner] = useState("");
  const [waypoints, setWaypoints] = useState<unknown[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
      setError(err instanceof Error ? err.message : "Unknown error");
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
        <CardTitle>Extract Waypoints</CardTitle>
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
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label htmlFor="title">Title filter</Label>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="icon">Icon filter</Label>
              <Input id="icon" value={icon} onChange={(e) => setIcon(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="owner">Owner filter</Label>
              <Input id="owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
            </div>
          </div>
          <Button type="submit" disabled={!saveFile || loading}>
            {loading ? "Extracting…" : "Extract"}
          </Button>
          {error && <p className="text-red-500 text-sm">{error}</p>}
        </form>

        {waypoints.length > 0 && (
          <div className="mt-6 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {waypoints.length} waypoint(s) found
              </p>
              <Button variant="outline" size="sm" onClick={downloadJson}>
                Download JSON
              </Button>
            </div>
            <WaypointTable waypoints={waypoints as never[]} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
