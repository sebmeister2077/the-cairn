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

export function WhatToDoDialog() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" variant="outline" size="sm">
            <HelpCircle className="size-4 mr-1" />
            What to do now?
          </Button>
        }
      />
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>How to review your translocators</DialogTitle>
          <DialogDescription>
            We pre-grouped your spiral waypoints into translocator pairs and matched them against
            the existing map. Skim each section below and only the groups that need your attention
            before submitting.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <section className="space-y-1">
            <Badge variant="default">New — confirmed</Badge>
            <p className="text-muted-foreground">
              Two of your waypoints clearly belong together (the partner is within 7 blocks of the
              label coordinates, or it&rsquo;s the only candidate in the area). These are ready to
              submit as-is — no action needed.
            </p>
          </section>
          <section className="space-y-1">
            <Badge variant="secondary">New — needs review</Badge>
            <p className="text-muted-foreground">
              We found multiple possible partners within 50 blocks of the label, so the pairing is
              ambiguous. Click the entry to highlight it on the map, then either:
            </p>
            <ul className="list-disc pl-5 text-muted-foreground space-y-1">
              <li>
                Confirm by clicking <strong>Edit</strong> and saving (no changes needed) — that
                locks in the pairing as manual.
              </li>
              <li>
                Use <strong>Link two TLs</strong> to merge the correct endpoints together.
              </li>
              <li>Drag an endpoint handle on the map to snap it to the right partner.</li>
            </ul>
          </section>
          <section className="space-y-1">
            <Badge variant="destructive">Unpaired</Badge>
            <p className="text-muted-foreground">
              These waypoints have no partner — usually because the label doesn&rsquo;t contain
              readable target coordinates, the target is outside the typical 1000–14000 block range,
              or the matching waypoint wasn&rsquo;t in the chat-log. To fix:
            </p>
            <ul className="list-disc pl-5 text-muted-foreground space-y-1">
              <li>
                If you have <em>two</em> unpaired entries that should go together, click{" "}
                <strong>Link two TLs</strong> in the map toolbar, then click an endpoint handle on
                each TL.
              </li>
              <li>
                Or click <strong>Edit</strong> and type the partner&rsquo;s X/Z coordinates
                manually.
              </li>
              <li>
                If you can&rsquo;t pair it (you only have one side), <strong>remove</strong> it — we
                can&rsquo;t accept half-translocators.
              </li>
            </ul>
          </section>
          <section className="space-y-1">
            <Badge variant="destructive">Invalid</Badge>
            <p className="text-muted-foreground">
              Something is wrong with this entry (e.g. duplicate coordinates, or you merged it into
              another TL). Read the inline reason and either fix it via <strong>Edit</strong> or{" "}
              <strong>remove</strong> it.
            </p>
          </section>
          <section className="space-y-1">
            <Badge variant="outline">Already on map</Badge>
            <p className="text-muted-foreground">
              Both endpoints match an existing translocator on the server. These are skipped at
              submit-time — they&rsquo;re shown only so you can see what we already know about.
            </p>
          </section>
          <section className="border-t pt-3 space-y-1">
            <h4 className="font-semibold">Map controls</h4>
            <ul className="list-disc pl-5 text-muted-foreground space-y-1">
              <li>Pan with mouse-drag, zoom with the scroll wheel.</li>
              <li>
                Toggle <strong>Lock map</strong> to drag endpoint handles without panning.
              </li>
              <li>Endpoints snap to existing translocator endpoints within 7 blocks.</li>
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
