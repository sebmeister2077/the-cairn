import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Trans, useTranslation } from "@/lib/i18n";

export function GeneralPage() {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("generalPage.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-muted-foreground">
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <Trans
            path="generalPage.disclaimer"
            components={{
              strong: <strong />,
              em: <em />,
            }}
          />
        </div>
        <p className="rounded border border-border bg-muted/40 p-3 italic">
          <Trans
            path="generalPage.cairnDefinition"
            components={{
              strong: <strong className="not-italic text-foreground" />,
              link: (
                <a
                  href="https://en.wikipedia.org/wiki/Cairn"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-dotted underline-offset-2 hover:text-primary"
                />
              ),
              noun: <span className="not-italic" />,
            }}
          />
        </p>
        <p>{t("generalPage.intro")}</p>
        <div className="grid gap-3">
          <div>
            <p className="font-medium text-foreground">{t("generalPage.singleplayerTitle")}</p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>
                <strong>{t("app.nav.subtabs.extract")}</strong> &mdash;{" "}
                <Trans
                  path="generalPage.extractDescription"
                  components={{
                    code: <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono" />,
                  }}
                />
              </li>
              <li>
                <strong>{t("app.nav.subtabs.import")}</strong> &mdash;{" "}
                {t("generalPage.importDescription")}
              </li>
              <li>
                <strong>{t("app.nav.subtabs.commands")}</strong> &mdash;{" "}
                <Trans
                  path="generalPage.commandsDescription"
                  components={{
                    code: <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono" />,
                  }}
                />
              </li>
              <li>
                <strong>{t("app.nav.subtabs.delete")}</strong> &mdash;{" "}
                {t("generalPage.deleteDescription")}
              </li>
            </ul>
            <p className="text-xs italic mt-2">
              <Trans
                path="generalPage.singleplayerNote"
                components={{
                  code: <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono mx-1" />,
                }}
              />
            </p>
          </div>
          <div>
            <p className="font-medium text-foreground">{t("generalPage.multiplayerTitle")}</p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>
                <strong>{t("app.nav.subtabs.identifyMaps")}</strong> &mdash;{" "}
                <Trans
                  path="generalPage.identifyMapsDescription"
                  components={{
                    code: <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono" />,
                  }}
                />
              </li>
              <li>
                <strong>{t("app.nav.subtabs.localMapViewer")}</strong> &mdash;{" "}
                <Trans
                  path="generalPage.localMapViewerDescription"
                  components={{
                    code: <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono" />,
                  }}
                />
              </li>
              <li>
                <strong>{t("app.nav.subtabs.topsMapViewer")}</strong> &mdash;{" "}
                {t("generalPage.topsMapViewerDescription")}
              </li>
              <li>
                <strong>{t("app.nav.subtabs.contributeMap")}</strong> &mdash;{" "}
                {t("generalPage.contributeDescription")}
              </li>
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
