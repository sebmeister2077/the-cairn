import { Upload } from "lucide-react";
import { NavLink } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";

export function CantContributeCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5" />
          Contribute Map Data
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>
          This page lets players upload their local Vintage Story map cache so admins can review and
          merge new chunks into the shared community map.
        </p>
        <p>
          New here? Read the{" "}
          <NavLink
            to="/blog/contributing-to-the-tops-map"
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            guide to contributing to the TOPS map
          </NavLink>
          .
        </p>
        <div className="rounded-md border bg-muted/30 p-3">
          <p className="font-medium text-foreground">Access required</p>
          <p className="mt-1">
            Your current API key does not have contribute permission. Please request a{" "}
            <strong>Read &amp; Contribute</strong> key from an admin.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
