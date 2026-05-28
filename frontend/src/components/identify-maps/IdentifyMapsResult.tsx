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
import { useFormat, useTranslation } from "@/lib/i18n";

export function IdentifyMapsResult({ results }: { results: ServerMapResult[] }) {
  const { t } = useTranslation();
  const format = useFormat();

  return (
    <div className="mt-6 space-y-3">
      {results.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center">
          <p className="text-muted-foreground">{t("identifyMapsPage.noConnections")}</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t("identifyMapsPage.serverConnectionsFound", { count: results.length })}
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("identifyMapsPage.results.server")}</TableHead>
                <TableHead>{t("identifyMapsPage.results.databaseFile")}</TableHead>
                <TableHead className="text-right">{t("identifyMapsPage.results.size")}</TableHead>
                <TableHead className="text-right">
                  {t("identifyMapsPage.results.lastConnected")}
                </TableHead>
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
                      <Badge variant="outline">{t("identifyMapsPage.results.noMatch")}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.dbSizeMB != null ? `${r.dbSizeMB} MB` : "—"}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {format.dateTime(r.lastConnected, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}{" "}
                    <span className="text-muted-foreground">
                      {format.dateTime(r.lastConnected, {
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
