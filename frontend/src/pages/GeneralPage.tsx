import { Map, Route, Store, Upload, Waypoints, type LucideIcon } from "lucide-react";
import { NavLink } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Trans,
  useTranslation,
  type ArgsTuple,
  type PathOf,
  type TranslationSchema,
} from "@/lib/i18n";

// Keys that take no interpolation args, so `t(key)` is callable with a
// single argument even when the key is only known as a union at compile time.
type TKey = {
  [K in PathOf<TranslationSchema>]: ArgsTuple<K> extends [] ? K : never;
}[PathOf<TranslationSchema>];

const FEATURES: ReadonlyArray<{ icon: LucideIcon; titleKey: TKey; bodyKey: TKey }> = [
  {
    icon: Map,
    titleKey: "generalPage.features.mapTitle",
    bodyKey: "generalPage.features.mapBody",
  },
  {
    icon: Route,
    titleKey: "generalPage.features.routingTitle",
    bodyKey: "generalPage.features.routingBody",
  },
  {
    icon: Store,
    titleKey: "generalPage.features.marketTitle",
    bodyKey: "generalPage.features.marketBody",
  },
  {
    icon: Waypoints,
    titleKey: "generalPage.features.waypointsTitle",
    bodyKey: "generalPage.features.waypointsBody",
  },
  {
    icon: Upload,
    titleKey: "generalPage.features.contributeTitle",
    bodyKey: "generalPage.features.contributeBody",
  },
];

const QUICK_LINKS: ReadonlyArray<{ to: string; icon: LucideIcon; labelKey: TKey }> = [
  { to: "/multiplayer/tops-map", icon: Map, labelKey: "generalPage.quickLinks.map" },
  { to: "/market", icon: Store, labelKey: "generalPage.quickLinks.market" },
  { to: "/singleplayer/extract", icon: Waypoints, labelKey: "generalPage.quickLinks.extract" },
  {
    to: "/multiplayer/contribute-map",
    icon: Upload,
    labelKey: "generalPage.quickLinks.contribute",
  },
];

export function GeneralPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      {/* Hero */}
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl sm:text-3xl">{t("generalPage.title")}</CardTitle>
          <p className="text-sm font-medium text-muted-foreground">{t("generalPage.tagline")}</p>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <p className="text-base text-foreground">{t("generalPage.intro")}</p>
          <div className="flex flex-wrap gap-2">
            {QUICK_LINKS.map(({ to, icon: Icon, labelKey }) => (
              <Button key={to} size="sm" variant="secondary" render={<NavLink to={to} />}>
                <Icon className="size-4 mr-1.5" />
                {t(labelKey)}
              </Button>
            ))}
          </div>
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200">
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
        </CardContent>
      </Card>

      {/* Feature highlights */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("generalPage.featuresTitle")}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, titleKey, bodyKey }) => (
            <Card key={titleKey} className="h-full">
              <CardContent className="flex h-full flex-col gap-2 p-4">
                <div className="flex items-center gap-2">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="size-4" />
                  </span>
                  <h3 className="font-medium text-foreground">{t(titleKey)}</h3>
                </div>
                <p className="text-sm text-muted-foreground">{t(bodyKey)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Detailed tool overview */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("generalPage.singleplayerTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>
                <strong className="text-foreground">{t("app.nav.subtabs.extract")}</strong> &mdash;{" "}
                <Trans
                  path="generalPage.extractDescription"
                  components={{
                    code: <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono" />,
                  }}
                />
              </li>
              <li>
                <strong className="text-foreground">{t("app.nav.subtabs.import")}</strong> &mdash;{" "}
                {t("generalPage.importDescription")}
              </li>
              <li>
                <strong className="text-foreground">{t("app.nav.subtabs.commands")}</strong> &mdash;{" "}
                <Trans
                  path="generalPage.commandsDescription"
                  components={{
                    code: <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono" />,
                  }}
                />
              </li>
              <li>
                <strong className="text-foreground">{t("app.nav.subtabs.delete")}</strong> &mdash;{" "}
                {t("generalPage.deleteDescription")}
              </li>
            </ul>
            <p className="text-xs italic">
              <Trans
                path="generalPage.singleplayerNote"
                components={{
                  code: <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono mx-1" />,
                }}
              />
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("generalPage.multiplayerTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>
                <strong className="text-foreground">{t("app.nav.subtabs.identifyMaps")}</strong>{" "}
                &mdash;{" "}
                <Trans
                  path="generalPage.identifyMapsDescription"
                  components={{
                    code: <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono" />,
                  }}
                />
              </li>
              <li>
                <strong className="text-foreground">{t("app.nav.subtabs.localMapViewer")}</strong>{" "}
                &mdash;{" "}
                <Trans
                  path="generalPage.localMapViewerDescription"
                  components={{
                    code: <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono" />,
                  }}
                />
              </li>
              <li>
                <strong className="text-foreground">{t("app.nav.subtabs.topsMapViewer")}</strong>{" "}
                &mdash; {t("generalPage.topsMapViewerDescription")}
              </li>
              <li>
                <strong className="text-foreground">{t("app.nav.subtabs.contributeMap")}</strong>{" "}
                &mdash; {t("generalPage.contributeDescription")}
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
