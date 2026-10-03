import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { adminUsage } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loading } from "@/components/usage/Loading";
import { ErrorMsg } from "@/components/usage/ErrorMsg";
import { useItemCatalog } from "@/lib/auction";

// ---------------------------------------------------------------------------
// Section: Items & Players — most-viewed market entities (per-ref analytics).
// ---------------------------------------------------------------------------

type EntityKind = "items" | "players";

const ENTITY_KINDS: {
  key: EntityKind;
  label: string;
  path: string;
  hrefBase: string;
  encode: boolean;
}[] = [
  {
    key: "items",
    label: "Items",
    path: "/market/items/:itemId",
    hrefBase: "/market/items/",
    encode: false,
  },
  {
    key: "players",
    label: "Players",
    path: "/market/players/:uid",
    hrefBase: "/market/players/",
    encode: true,
  },
];

export function EntitiesSection(props: { from: string; to: string }) {
  const [kind, setKind] = useState<EntityKind>("items");
  const cfg = ENTITY_KINDS.find((k) => k.key === kind) ?? ENTITY_KINDS[0];
  // Item names are also resolvable client-side from the catalog, so item rows
  // still show a name even before any label has been reported for them.
  const catalog = useItemCatalog();

  const q = useQuery({
    queryKey: ["usage", "page-entities", cfg.path, props.from, props.to],
    queryFn: ({ signal }) =>
      adminUsage.pageEntities(
        { from: props.from, to: props.to, path: cfg.path, limit: 30 },
        signal,
      ),
  });

  const rows = q.data?.top ?? [];
  const maxViews = rows.reduce((m, r) => Math.max(m, r.views), 0) || 1;

  const nameFor = (ref: string, label: string | null): string | null => {
    if (label) return label;
    if (kind === "items") {
      const entry = catalog.data?.[ref];
      if (entry) return entry.name;
    }
    return null;
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-3">
          <div className="space-y-1">
            <CardTitle>Most viewed {kind === "items" ? "items" : "player profiles"}</CardTitle>
            <CardDescription>
              Ranks individual {kind === "items" ? "item" : "player"} pages by views. Names are
              reported by the page itself the first time it's opened, so a freshly-viewed entity may
              briefly show only its id. Distinct actors = signed-in API keys; distinct IPs = unique
              hashed visitor IPs.
            </CardDescription>
          </div>
          <Tabs value={kind} onValueChange={(v) => setKind(v as EntityKind)}>
            <TabsList>
              {ENTITY_KINDS.map((k) => (
                <TabsTrigger key={k.key} value={k.key}>
                  {k.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <Loading />
          ) : q.isError || !q.data ? (
            <ErrorMsg msg="Failed to load entity analytics." />
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No {kind === "items" ? "item" : "player"} views recorded in this window.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="py-2 pr-4 font-medium">
                      {kind === "items" ? "Item" : "Player"}
                    </th>
                    <th className="py-2 pr-4 font-medium">Id</th>
                    <th className="py-2 pr-4 font-medium tabular-nums text-right">Views</th>
                    <th className="py-2 pr-4 font-medium tabular-nums text-right">Actors</th>
                    <th className="py-2 pr-4 font-medium tabular-nums text-right">IPs</th>
                    <th className="py-2 font-medium w-1/3">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const name = nameFor(row.ref, row.label);
                    const href = `${cfg.hrefBase}${cfg.encode ? encodeURIComponent(row.ref) : row.ref}`;
                    return (
                      <tr key={row.ref} className="border-b hover:bg-accent/40">
                        <td className="py-2 pr-4">
                          <Link to={href} className="text-primary hover:underline">
                            {name ?? <span className="text-muted-foreground italic">Unknown</span>}
                          </Link>
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                          {row.ref}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {row.views.toLocaleString()}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {row.distinct_actors.toLocaleString()}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {row.distinct_ips.toLocaleString()}
                        </td>
                        <td className="py-2">
                          <div className="h-2 bg-muted rounded">
                            <div
                              className="h-2 bg-primary rounded"
                              style={{ width: `${(row.views / maxViews) * 100}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
