/**
 * Contribute Translocators page.
 *
 * Tabbed shell hosting two independent contribution flows:
 *   1. Chat log — parses a `client-chat.log` file and submits paired
 *      translocators (the original flow).
 *   2. Screenshots — uploads two screenshots (one per TL endpoint) and
 *      lets the backend OCR coordinates + verify the minimap matches
 *      the server map. Admin reviews each pair before it goes live.
 */

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ChatLogContributeFlow } from "@/components/contribute-tls/ChatLogContributeFlow";
import { ScreenshotPairUploadCard } from "@/components/contribute-tls/ScreenshotPairUploadCard";
import { MyScreenshotRequestsList } from "@/components/contribute-tls/MyScreenshotRequestsList";

export function ContributeTLsPage() {
  return (
    <div className="space-y-4">
      <Tabs defaultValue="screenshots">
        <TabsList variant="line">
          <TabsTrigger value="screenshots">From screenshots</TabsTrigger>
          <TabsTrigger value="chatlog">From chat log</TabsTrigger>
        </TabsList>
        <TabsContent value="chatlog" className="pt-2">
          <ChatLogContributeFlow />
        </TabsContent>
        <TabsContent value="screenshots" className="pt-2">
          <div className="max-w-3xl mx-auto space-y-4">
            <ScreenshotPairUploadCard />
            <MyScreenshotRequestsList />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
