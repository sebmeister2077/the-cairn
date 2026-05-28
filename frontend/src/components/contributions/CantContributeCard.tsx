import { Upload } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { NavLink } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";

export function CantContributeCard() {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5" />
          {t("contributePage.cantContribute.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>{t("contributePage.cantContribute.description")}</p>
        <p>
          {t("contributePage.cantContribute.guidePrefix")}{" "}
          <NavLink
            to="/blog/contributing-to-the-tops-map"
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            {t("contributePage.cantContribute.guide")}
          </NavLink>
          .
        </p>
        <div className="rounded-md border bg-muted/30 p-3">
          <p className="font-medium text-foreground">
            {t("contributePage.cantContribute.accessRequiredTitle")}
          </p>
          <p className="mt-1">{t("contributePage.cantContribute.accessRequired")}</p>
        </div>
      </CardContent>
    </Card>
  );
}
