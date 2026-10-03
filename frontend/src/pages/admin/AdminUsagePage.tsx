import { PromoSection } from "@/components/admin/usage/PromoSection";
import { SavedRoutesSection } from "@/components/admin/usage/SavedRoutesSection";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DateRangeBar } from "@/components/usage/DateRangeBar";
import { GranularityToggle } from "@/components/usage/GranularityToggle";
import { AccountsSection } from "@/components/usage/sections/UsageAccountsSection";
import { AdminActivitySection } from "@/components/usage/sections/UsageAdminActivitySection";
import { ContributionsSection } from "@/components/usage/sections/UsageContributionsSection";
import { DownloadsSection } from "@/components/usage/sections/UsageDownloadSection";
import { EntitiesSection } from "@/components/usage/sections/UsageItemPlayerSection";
import { MapLayersSection } from "@/components/usage/sections/UsageMapLayersSection";
import { ModerationSection } from "@/components/usage/sections/UsageModerationSection";
import { OverviewSection } from "@/components/usage/sections/UsageOverviewSection";
import { PagesSection } from "@/components/usage/sections/UsagePagesSection";
import { QueueVelocitySection } from "@/components/usage/sections/UsageQueueVelocitySection";
import { TopActorsSection } from "@/components/usage/sections/UsageTopActorsSection";
import { type UsageGranularity } from "@/lib/api";
import { MONTH_MS } from "@/lib/constants/time";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
/**
 * Admin "Usage" dashboard.
 *
 * Read-only telemetry: drag a date range + granularity, see how the app
 * is being used. All sections share the same window/granularity state so
 * scrubbing recomputes every chart in lockstep.
 */
type SectionKey =
  | "overview"
  | "contributions"
  | "pages"
  | "entities"
  | "map_layers"
  | "saved_routes"
  | "admin"
  | "queues"
  | "downloads"
  | "moderation"
  | "api_keys"
  | "actors"
  | "promo";

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "contributions", label: "Contributions" },
  { key: "pages", label: "Pages" },
  { key: "entities", label: "Items & Players" },
  { key: "map_layers", label: "Map Layers" },
  { key: "saved_routes", label: "Saved Routes" },
  { key: "admin", label: "Admin Activity" },
  { key: "queues", label: "Queue Velocity" },
  { key: "downloads", label: "Downloads" },
  { key: "moderation", label: "Moderation" },
  { key: "api_keys", label: "Accounts" },
  { key: "actors", label: "Top Actors" },
  { key: "promo", label: "Promo" },
];

function defaultWindow(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - MONTH_MS);
  return { from: from.toISOString(), to: to.toISOString() };
}

const VALID_SECTIONS = new Set<string>(SECTIONS.map((s) => s.key));

export function AdminUsagePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // The active tab lives in the URL (?tab=…) so a refresh or shared link
  // lands on the same section. Falls back to "overview" for missing/unknown
  // values.
  const tabParam = searchParams.get("tab");
  const section: SectionKey =
    tabParam && VALID_SECTIONS.has(tabParam) ? (tabParam as SectionKey) : "overview";
  const setSection = (next: SectionKey) => {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("tab", next);
        return p;
      },
      { replace: true },
    );
  };
  const [range, setRange] = useState<{ from: string; to: string }>(defaultWindow);
  const [granularity, setGranularity] = useState<UsageGranularity>("day");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="space-y-2">
          <CardTitle>Usage Analytics</CardTitle>
          <CardDescription>
            Patterns and waves of activity across the app. All times in UTC.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <DateRangeBar value={range} onChange={setRange} />
          <GranularityToggle value={granularity} onChange={setGranularity} />
        </CardContent>
      </Card>

      <Tabs value={section} onValueChange={(v) => setSection(v as SectionKey)}>
        <TabsList className="flex gap-1 h-auto flex-nowrap">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s.key} value={s.key} className="flex-none">
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {section === "overview" && (
        <OverviewSection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "contributions" && (
        <ContributionsSection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "pages" && (
        <PagesSection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "entities" && <EntitiesSection from={range.from} to={range.to} />}
      {section === "map_layers" && (
        <MapLayersSection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "saved_routes" && (
        <SavedRoutesSection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "admin" && (
        <AdminActivitySection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "queues" && <QueueVelocitySection from={range.from} to={range.to} />}
      {section === "downloads" && (
        <DownloadsSection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "moderation" && (
        <ModerationSection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "api_keys" && (
        <AccountsSection from={range.from} to={range.to} granularity={granularity} />
      )}
      {section === "actors" && <TopActorsSection from={range.from} to={range.to} />}
      {section === "promo" && (
        <PromoSection from={range.from} to={range.to} granularity={granularity} />
      )}
    </div>
  );
}
