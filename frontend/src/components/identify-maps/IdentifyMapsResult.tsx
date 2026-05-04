import type { ServerMapResult } from "@/lib/identify-maps";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "../ui/badge";

export function IdentifyMapsResult({ results }: { results: ServerMapResult[] }) {
  return (
    <div className="mt-6 space-y-3">
      {results.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center">
          <p className="text-muted-foreground">
            No multiplayer connections found in the provided log file.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {results.length} server connection{results.length !== 1 && "s"} found
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Server</TableHead>
                <TableHead>Database File</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Last Connected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((r) => (
                <TableRow key={r.serverAddress}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      {r.friendlyName && <span className="font-medium">{r.friendlyName}</span>}
                      <span
                        className={r.friendlyName ? "text-xs text-muted-foreground" : "font-medium"}
                      >
                        {r.serverAddress}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {r.dbFile ? (
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                        {r.dbFile}
                      </code>
                    ) : (
                      <Badge variant="outline">No match</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.dbSizeMB != null ? `${r.dbSizeMB} MB` : "—"}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {r.lastConnected.toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}{" "}
                    <span className="text-muted-foreground">
                      {r.lastConnected.toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}
