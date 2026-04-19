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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import "./index.css";

const categories = [
  { value: "/singleplayer", label: "Singleplayer" },
  { value: "/multiplayer", label: "Multiplayer" },
  { value: "/general", label: "General" },
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
    { value: "/multiplayer/map-viewer", label: "Map Viewer" },
  ],
  "/general": [],
};

function getActiveCategory(pathname: string) {
  for (const cat of categories) {
    if (pathname.startsWith(cat.value)) return cat.value;
  }
  return "/singleplayer";
}

function AppContent() {
  const [keyOpen, setKeyOpen] = useState(false);
  const location = useLocation();
  const activeCategory = getActiveCategory(location.pathname);
  const activeSubs = subTabs[activeCategory] ?? [];

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
          <Tabs>
            <TabsList>
              {categories.map((c) => (
                <NavLink key={c.value} to={c.value} end={false}>
                  {() => (
                    <TabsTrigger
                      value={c.value}
                      data-state={activeCategory === c.value ? "active" : "inactive"}
                    >
                      {c.label}
                    </TabsTrigger>
                  )}
                </NavLink>
              ))}
            </TabsList>
          </Tabs>
          {activeSubs.length > 0 && (
            <Tabs>
              <TabsList variant="line">
                {activeSubs.map((t) => (
                  <NavLink key={t.value} to={t.value}>
                    {({ isActive }) => (
                      <TabsTrigger
                        value={t.value}
                        data-state={isActive ? "active" : "inactive"}
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
          <Route path="/" element={<Navigate to="/singleplayer/extract" replace />} />
          <Route path="/singleplayer" element={<Navigate to="/singleplayer/extract" replace />} />
          <Route path="/singleplayer/extract" element={<ExtractPage />} />
          <Route path="/singleplayer/import" element={<ImportPage />} />
          <Route path="/singleplayer/commands" element={<CommandsPage />} />
          <Route path="/singleplayer/delete" element={<DeletePage />} />
          <Route path="/multiplayer" element={<Navigate to="/multiplayer/identify" replace />} />
          <Route path="/multiplayer/identify" element={<IdentifyMapsPage />} />
          <Route path="/multiplayer/map-viewer" element={<MapViewPage />} />
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
          A web toolkit for managing Vintage Story waypoints. Choose a category above to get started.
        </p>
        <div className="grid gap-3">
          <div>
            <p className="font-medium text-foreground">Singleplayer</p>
            <p>Extract, import, delete, and generate commands for waypoints from your <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.vcdbs</code> save files.</p>
          </div>
          <div>
            <p className="font-medium text-foreground">Multiplayer</p>
            <p>Identify which map database files in your Maps folder belong to which server.</p>
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
