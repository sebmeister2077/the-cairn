import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2, PackageOpen, XCircle } from "lucide-react";
import { getProgramDownloadInfo, programDownloadUrl } from "@/lib/api";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

function fmtBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function DownloadPage() {
  const { token = "" } = useParams();
  const info = useQuery({
    queryKey: ["program-download-info", token],
    queryFn: () => getProgramDownloadInfo(token),
    enabled: token.length > 0,
    retry: false,
  });

  const unavailable = info.isError || (info.data && info.data.status !== "active");

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md items-center justify-center p-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <PackageOpen className="size-5" /> VSProxy download
          </CardTitle>
          <CardDescription>
            A pre-configured VSProxy build{info.data?.label ? ` for ${info.data.label}` : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {info.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Checking link…
            </div>
          )}

          {!info.isLoading && unavailable && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <XCircle className="mt-0.5 size-4 text-destructive" />
              <div>
                <div className="font-medium">This link is no longer available.</div>
                <p className="text-muted-foreground">
                  It may have expired or been revoked. Ask the administrator for a new link.
                </p>
              </div>
            </div>
          )}

          {!info.isLoading && !unavailable && info.data && (
            <>
              <div className="rounded-md border px-3 py-2 text-sm">
                <div className="font-medium">{info.data.filename}</div>
                {fmtBytes(info.data.size_bytes) && (
                  <div className="text-xs text-muted-foreground">
                    {fmtBytes(info.data.size_bytes)}
                  </div>
                )}
              </div>

              <a
                href={programDownloadUrl(token)}
                download
                className={buttonVariants({ className: "w-full" })}
              >
                <Download className="size-4" /> Download zip
              </a>

              <p className="text-xs text-muted-foreground">
                {info.data.include_keys ? (
                  <>
                    The zip contains the program plus your personal <code>license.key</code> and{" "}
                    <code>publish.key</code>. Keep all files together in one folder and run the exe —
                    no extra setup needed.
                  </>
                ) : (
                  <>
                    This is a program update — the zip contains only the exe. Replace your existing{" "}
                    VSProxy.exe and keep your current <code>license.key</code> and{" "}
                    <code>publish.key</code> in the same folder.
                  </>
                )}{" "}
                Unofficial tool; not affiliated with Anego Studios.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
