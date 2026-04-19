import { useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ApiKeyDialog } from "@/components/ApiKeyDialog";
import { ExtractPage } from "@/pages/ExtractPage";
import { ImportPage } from "@/pages/ImportPage";
import { CommandsPage } from "@/pages/CommandsPage";
import { DeletePage } from "@/pages/DeletePage";
import { IdentifyMapsPage } from "@/pages/IdentifyMapsPage";
import { MapViewPage } from "@/pages/MapViewPage";
import { TOPSMapViewPage } from "@/pages/TOPSMapViewPage";
import { ContributePage } from "@/pages/ContributePage";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import "./index.css";

const categories = [
  { value: "/general", label: "General" },
  { value: "/singleplayer", label: "Singleplayer" },
  { value: "/multiplayer", label: "Multiplayer" },
] as const;

const subTabs: Record<string, { value: string; label: string }[]> = {
  "/singleplayer": [
    { value: "/singleplayer/extract", label: "Extract" },
    { value: "/singleplayer/import", label: "Import" },
    { value: "/singleplayer/commands", label: "Commands" },
    { value: "/singleplayer/delete", label: "Delete" },
  ],
  "/multiplayer": [
    { value: "/multiplayer/identify", label: "Identify Maps" },
    { value: "/multiplayer/map-viewer", label: "Local Map Viewer" },
    { value: "/multiplayer/tops-map", label: "TOPS Map Viewer" },
    { value: "/multiplayer/contribute", label: "Contribute" },
  ],
  "/general": [],
};

function getActiveCategory(pathname: string) {
  for (const cat of categories) {
    if (pathname.startsWith(cat.value)) return cat.value;
  }
  return "/general";
}

function AppContent() {
  const [keyOpen, setKeyOpen] = useState(false);
  const location = useLocation();
  const activeCategory = getActiveCategory(location.pathname);
  const activeSubs = subTabs[activeCategory] ?? [];
  const activeSub = activeSubs.find((t) => location.pathname === t.value)?.value ?? "";

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto flex items-center justify-between px-4 py-3">
          <h1 className="text-lg font-semibold">VS Waypoint Tools</h1>
          <Button variant="ghost" size="sm" onClick={() => setKeyOpen(true)}>
            API Key
          </Button>
        </div>
        <nav className="container mx-auto px-4 pb-2 flex flex-col gap-1">
          <Tabs value={activeCategory}>
            <TabsList>
              {categories.map((c) => (
                <NavLink key={c.value} to={c.value} end={false}>
                  {() => (
                    <TabsTrigger
                      value={c.value}
                    >
                      {c.label}
                    </TabsTrigger>
                  )}
                </NavLink>
              ))}
            </TabsList>
          </Tabs>
          {activeSubs.length > 0 && (
            <Tabs value={activeSub}>
              <TabsList variant="line">
                {activeSubs.map((t) => (
                  <NavLink key={t.value} to={t.value} end>
                    {() => (
                      <TabsTrigger
                        value={t.value}
                      >
                        {t.label}
                      </TabsTrigger>
                    )}
                  </NavLink>
                ))}
              </TabsList>
            </Tabs>
          )}
        </nav>
      </header>
      <main className="container mx-auto px-4 py-6 max-w-3xl">
        <Routes>
          <Route path="/" element={<Navigate to="/general" replace />} />
          <Route path="/singleplayer" element={<Navigate to="/singleplayer/extract" replace />} />
          <Route path="/singleplayer/extract" element={<ExtractPage />} />
          <Route path="/singleplayer/import" element={<ImportPage />} />
          <Route path="/singleplayer/commands" element={<CommandsPage />} />
          <Route path="/singleplayer/delete" element={<DeletePage />} />
          <Route path="/multiplayer" element={<Navigate to="/multiplayer/identify" replace />} />
          <Route path="/multiplayer/identify" element={<IdentifyMapsPage />} />
          <Route path="/multiplayer/map-viewer" element={<MapViewPage />} />
          <Route path="/multiplayer/tops-map" element={<TOPSMapViewPage />} />
          <Route path="/multiplayer/contribute" element={<ContributePage />} />
          <Route path="/general" element={<GeneralPage />} />
        </Routes>
      </main>
      <ApiKeyDialog open={keyOpen} onClose={() => setKeyOpen(false)} />
    </div>
  );
}

function GeneralPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>VS Waypoint Tools</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-muted-foreground">
        <p>
          A web toolkit for managing Vintage Story waypoints and map data. Choose a category above to get started.
        </p>
        <div className="grid gap-3">
          <div>
            <p className="font-medium text-foreground">Singleplayer</p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li><strong>Extract</strong> &mdash; pull waypoints out of your <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.vcdbs</code> save file into JSON.</li>
              <li><strong>Import</strong> &mdash; write waypoints back into a save file (append or replace).</li>
              <li><strong>Commands</strong> &mdash; generate <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">/waypoint addati</code> chat commands from a JSON list.</li>
              <li><strong>Delete</strong> &mdash; remove matching waypoints from a save file by name, icon, or colour.</li>
            </ul>
          </div>
          <div>
            <p className="font-medium text-foreground">Multiplayer</p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li><strong>Identify Maps</strong> &mdash; figure out which <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.db</code> map cache files belong to which server using your client log.</li>
              <li><strong>Local Map Viewer</strong> &mdash; render and explore a cached map <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.db</code> file as an interactive image.</li>
              <li><strong>TOPS Map Viewer</strong> &mdash; explore the community-contributed global server map.</li>
              <li><strong>Contribute</strong> &mdash; upload your map cache to help build a shared community map for your server.</li>
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
