import { useState } from "react";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ApiKeyDialog } from "@/components/ApiKeyDialog";
import { ExtractPage } from "@/pages/ExtractPage";
import { ImportPage } from "@/pages/ImportPage";
import { CommandsPage } from "@/pages/CommandsPage";
import { DeletePage } from "@/pages/DeletePage";
import "./index.css";

const tabs = [
  { value: "/", label: "Extract" },
  { value: "/import", label: "Import" },
  { value: "/commands", label: "Commands" },
  { value: "/delete", label: "Delete" },
] as const;

function AppContent() {
  const [keyOpen, setKeyOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto flex items-center justify-between px-4 py-3">
          <h1 className="text-lg font-semibold">VS Waypoint Tools</h1>
          <Button variant="ghost" size="sm" onClick={() => setKeyOpen(true)}>
            API Key
          </Button>
        </div>
        <nav className="container mx-auto px-4 pb-2">
          <Tabs>
            <TabsList>
              {tabs.map((t) => (
                <NavLink key={t.value} to={t.value}>
                  {({ isActive }) => (
                    <TabsTrigger value={t.value} data-state={isActive ? "active" : "inactive"}>
                      {t.label}
                    </TabsTrigger>
                  )}
                </NavLink>
              ))}
            </TabsList>
          </Tabs>
        </nav>
      </header>
      <main className="container mx-auto px-4 py-6 max-w-3xl">
        <Routes>
          <Route path="/" element={<ExtractPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/commands" element={<CommandsPage />} />
          <Route path="/delete" element={<DeletePage />} />
        </Routes>
      </main>
      <ApiKeyDialog open={keyOpen} onClose={() => setKeyOpen(false)} />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
