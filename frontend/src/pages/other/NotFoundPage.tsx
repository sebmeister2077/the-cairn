import { NavLink } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="flex justify-center py-12">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <p className="text-5xl font-bold text-muted-foreground">404</p>
          <CardTitle>{t("app.notFound.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("app.notFound.description")}</p>
          <NavLink to="/">
            <Button>{t("app.notFound.goHome")}</Button>
          </NavLink>
        </CardContent>
      </Card>
    </div>
  );
}
