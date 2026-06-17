// Reference panel listing the available /waypoint commands.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WAYPOINT_COMMAND_CATALOG } from "@/lib/waypoint-macro";

export function CommandCatalog() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Available /waypoint commands</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          These are the chat commands a macro can run. When you remove a waypoint, every waypoint
          with a higher id is renumbered down by one.
        </p>
        <ul className="space-y-3">
          {WAYPOINT_COMMAND_CATALOG.map((entry) => (
            <li key={entry.id} className="space-y-1">
              <code className="block rounded bg-muted px-2 py-1 text-xs">{entry.template}</code>
              <p className="text-xs text-muted-foreground">{entry.description}</p>
              {entry.params.length > 0 && (
                <ul className="ml-3 list-disc space-y-0.5 text-xs text-muted-foreground">
                  {entry.params.map((p) => (
                    <li key={p.name}>
                      <span className="font-medium text-foreground">{p.name}</span> —{" "}
                      {p.description}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
