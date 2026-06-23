import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTranslation } from "@/lib/i18n";
import type { UseTLGroupingsResult } from "@/lib/tl-groupings";

import { BrowseLibraryTab } from "./tabs/BrowseLibraryTab";
import { GroupingReportsAdminTab } from "./tabs/GroupingReportsAdminTab";
import { MyPublishedGroupingsTab } from "./tabs/MyPublishedGroupingsTab";
import { SubscribedGroupingsTab } from "./tabs/SubscribedGroupingsTab";

interface GroupingLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  store: UseTLGroupingsResult;
  isAdmin: boolean;
}

type TabKey = "browse" | "mine" | "subscriptions" | "reports";

export function GroupingLibraryDialog({
  open,
  onOpenChange,
  store,
  isAdmin,
}: GroupingLibraryDialogProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabKey>("browse");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl" showCloseButton>
        <DialogHeader>
          <DialogTitle>{t("topsMap.groupingsDrawer.library.browseTitle")}</DialogTitle>
          <DialogDescription>
            {t("topsMap.groupingsDrawer.library.browseDescription")}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as TabKey)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="flex w-full flex-wrap">
            <TabsTrigger value="browse">
              {t("topsMap.groupingsDrawer.library.tabs.browse")}
            </TabsTrigger>
            <TabsTrigger value="mine">{t("topsMap.groupingsDrawer.library.tabs.mine")}</TabsTrigger>
            <TabsTrigger value="subscriptions">
              {t("topsMap.groupingsDrawer.library.tabs.subscriptions")}
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="reports">
                {t("topsMap.groupingsDrawer.library.tabs.reports")}
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="browse" className="flex min-h-0 flex-1 flex-col gap-3">
            <BrowseLibraryTab store={store} isAdmin={isAdmin} active={open && tab === "browse"} />
          </TabsContent>

          <TabsContent value="mine" className="min-h-0 flex-1 overflow-y-auto">
            <MyPublishedGroupingsTab store={store} active={open && tab === "mine"} />
          </TabsContent>

          <TabsContent value="subscriptions" className="min-h-0 flex-1 overflow-y-auto">
            <SubscribedGroupingsTab
              store={store}
              active={open && (tab === "subscriptions" || tab === "browse")}
            />
          </TabsContent>

          {isAdmin && (
            <TabsContent value="reports" className="min-h-0 flex-1 overflow-y-auto">
              <GroupingReportsAdminTab />
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
