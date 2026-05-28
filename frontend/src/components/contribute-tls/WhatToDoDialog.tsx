/**
 * "What to do now?" help dialog for the Contribute TLs review step.
 *
 * Explains the meaning of each status group, what action is expected from
 * the user for each, and how to use the map (drag handles, link mode,
 * editing).
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { HelpCircle } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

export function WhatToDoDialog() {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" variant="outline" size="sm">
            <HelpCircle className="size-4 mr-1" />
            {t("contributeTLsPage.whatToDo.trigger")}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("contributeTLsPage.whatToDo.title")}</DialogTitle>
          <DialogDescription>{t("contributeTLsPage.whatToDo.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <section className="space-y-1">
            <Badge variant="default">{t("contributeTLsPage.whatToDo.newConfirmed")}</Badge>
            <p className="text-muted-foreground">
              {t("contributeTLsPage.whatToDo.newConfirmedBody")}
            </p>
          </section>
          <section className="space-y-1">
            <Badge variant="secondary">{t("contributeTLsPage.whatToDo.newNeedsReview")}</Badge>
            <p className="text-muted-foreground">
              {t("contributeTLsPage.whatToDo.newNeedsReviewBody")}
            </p>
            <ul className="list-disc pl-5 text-muted-foreground space-y-1">
              <li>{t("contributeTLsPage.whatToDo.reviewBullet1")}</li>
              <li>{t("contributeTLsPage.whatToDo.reviewBullet2")}</li>
              <li>{t("contributeTLsPage.whatToDo.reviewBullet3")}</li>
            </ul>
          </section>
          <section className="space-y-1">
            <Badge variant="destructive">{t("contributeTLsPage.whatToDo.unpaired")}</Badge>
            <p className="text-muted-foreground">{t("contributeTLsPage.whatToDo.unpairedBody")}</p>
            <ul className="list-disc pl-5 text-muted-foreground space-y-1">
              <li>{t("contributeTLsPage.whatToDo.unpairedBullet1")}</li>
              <li>{t("contributeTLsPage.whatToDo.unpairedBullet2")}</li>
              <li>{t("contributeTLsPage.whatToDo.unpairedBullet3")}</li>
            </ul>
          </section>
          <section className="space-y-1">
            <Badge variant="destructive">{t("contributeTLsPage.whatToDo.invalid")}</Badge>
            <p className="text-muted-foreground">{t("contributeTLsPage.whatToDo.invalidBody")}</p>
          </section>
          <section className="space-y-1">
            <Badge variant="outline">{t("contributeTLsPage.whatToDo.alreadyOnMap")}</Badge>
            <p className="text-muted-foreground">
              {t("contributeTLsPage.whatToDo.alreadyOnMapBody")}
            </p>
          </section>
          <section className="border-t pt-3 space-y-1">
            <h4 className="font-semibold">{t("contributeTLsPage.whatToDo.mapControls")}</h4>
            <ul className="list-disc pl-5 text-muted-foreground space-y-1">
              <li>{t("contributeTLsPage.whatToDo.mapControlsBullet1")}</li>
              {/* <li>
                Toggle <strong>Lock map</strong> to drag endpoint handles without panning.
              </li> */}
              <li>{t("contributeTLsPage.whatToDo.mapControlsBullet2")}</li>
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
