import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clock,
  Eye,
  FileImage,
  HelpCircle,
  MapPinned,
  Send,
  Upload,
} from "lucide-react";
import highlightedScreenshotImg from "@/assets/TLContributeExample_Highlighted.png";
import submitForReviewImg from "@/assets/ContributeTLSubmitForReview.png";
import submissionsSectionImg from "@/assets/TLContributeSubmissionSection.png";

export function SubmittingTranslocatorScreenshotsPost() {
  return (
    <div className="space-y-6 text-sm leading-relaxed">
      <Lede>
        The screenshot flow is for adding one complete translocator link when you do not want to
        export waypoint logs. You take one screenshot at endpoint A and one at endpoint B, upload
        both PNGs, and Cairn reads the coordinates from the HUD while comparing each minimap to the
        server map. The screenshots do not go straight onto the live map: they are analysed first,
        then an admin reviews the pair before approving it.
      </Lede>

      <Section title="What you need before uploading" icon={<FileImage className="size-4" />}>
        <Ul>
          <li>
            Stand at the <strong>first end</strong> of the repaired static translocator and take a
            normal in-game screenshot.
          </li>
          <li>
            Travel through the translocator, stand at the <strong>second end</strong>, and take a
            second screenshot.
          </li>
          <li>
            Keep both screenshots as PNG files. Vintage Story's default screenshot format is the
            format the upload form expects.
          </li>
          <li>
            Make sure you are signed in to your Cairn account. Screenshot submissions are tied to
            your account so they can be withdrawn, reviewed, approved, or rejected cleanly.
          </li>
        </Ul>
      </Section>

      <Section title="Take a useful screenshot" icon={<Camera className="size-4" />}>
        <P>
          The full screenshot matters. Do not crop down to just the minimap or just the
          translocator. Cairn needs the HUD and the surrounding context to verify the submission.
          The highlighted example below shows the important parts: the translocator is visible in
          the world, the minimap is visible in the top-right corner, and the coordinate readout is
          readable.
        </P>

        <ImageFigure
          src={highlightedScreenshotImg}
          alt="Vintage Story screenshot with the repaired translocator, minimap, and coordinate readout highlighted as required evidence."
          caption="A good screenshot shows the repaired translocator, the in-game minimap, and a readable coordinate readout in the same image."
        />

        <Callout tone="info">
          The screenshot can include normal HUD text, waypoint pins, the player marker, and the
          direction label. Those are expected. The important thing is that they do not hide the X/Z
          coordinates or cover most of the minimap terrain.
        </Callout>
      </Section>

      <Section title="What must be visible" icon={<Eye className="size-4" />}>
        <Checklist>
          <li>
            <strong>The coordinate readout:</strong> X and Z must be readable. Y may be present too,
            but Cairn only uses X and Z for the translocator endpoint.
          </li>
          <li>
            <strong>The in-game minimap:</strong> keep it visible in the top-right corner. The
            analysis worker crops this area and compares it against the shared server map.
          </li>
          <li>
            <strong>Enough terrain around the marker:</strong> a very zoomed-in minimap can still
            work, but more visible terrain gives the matcher more landmarks and reduces warnings.
          </li>
          <li>
            <strong>The repaired translocator:</strong> make it obvious that the screenshot was
            taken at a real repaired TL endpoint, not just somewhere nearby.
          </li>
          <li>
            <strong>One endpoint per screenshot:</strong> screenshot A should be one end of the TL;
            screenshot B should be the other end.
          </li>
        </Checklist>
      </Section>

      <Section title="Common screenshot mistakes" icon={<AlertTriangle className="size-4" />}>
        <StatusGrid>
          <MiniCard
            heading="Coordinates are hidden"
            badge={<Badge variant="destructive">fix</Badge>}
          >
            If chat, UI scaling, or another overlay covers the numbers, OCR may fail or find the
            wrong coordinates. Retake the screenshot with the readout visible.
          </MiniCard>
          <MiniCard heading="Minimap is missing" badge={<Badge variant="destructive">fix</Badge>}>
            The server-map comparison cannot run if the minimap is disabled, cropped out, or hidden
            behind another UI panel.
          </MiniCard>
          <MiniCard
            heading="Only one end uploaded"
            badge={<Badge variant="destructive">fix</Badge>}
          >
            A TL link needs both endpoints. Uploading the same endpoint twice, or uploading only one
            side, cannot create a useful pair.
          </MiniCard>
          <MiniCard
            heading="Wrong server or unexplored area"
            badge={<Badge variant="secondary">warning</Badge>}
          >
            If the minimap does not match the TOPS server map, Cairn shows a warning. Sometimes that
            means the screenshot is from another server; sometimes the shared map simply has not
            explored that area yet.
          </MiniCard>
        </StatusGrid>
      </Section>

      <Section title="Submit the pair" icon={<Upload className="size-4" />}>
        <P>
          Open the <strong>Contribute TLs</strong> page and use the screenshot submission card. Put
          the first endpoint in <strong>Screenshot A</strong> and the second endpoint in{" "}
          <strong>Screenshot B</strong>. The optional label is only there to help humans recognize
          the request later, so use something short like <Code>Spawn - NE outpost</Code> if it
          helps.
        </P>

        <ImageFigure
          src={submitForReviewImg}
          alt="Submit a translocator pair via screenshots card with screenshot A, screenshot B, an optional label, and Submit for review."
          caption="The submit card needs exactly two PNG screenshots: one for endpoint A and one for endpoint B."
        />

        <P>
          When both previews look right, click <strong>Submit for review</strong>. The upload first
          sends the PNGs to storage, then creates a pending request. From there, the analysis worker
          reads the screenshots and fills in the request details.
        </P>
      </Section>

      <Section title="What analysis does" icon={<MapPinned className="size-4" />}>
        <P>
          After submission, Cairn runs two checks on each screenshot. First, OCR reads the visible
          coordinate text and stores the found X/Z values. Second, the minimap is compared with the
          server's level-5 map crop around those coordinates. That comparison gives admins evidence
          that the screenshot belongs to the same server and the same area.
        </P>
        <Ol>
          <li>
            <strong>Queued</strong> means your request is waiting for the worker.
          </li>
          <li>
            <strong>Analysing</strong> means OCR and minimap matching are running.
          </li>
          <li>
            <strong>Done</strong> means the request has found coordinates and is ready for admin
            review, possibly with warnings.
          </li>
          <li>
            <strong>Analysis failed</strong> means the worker could not process the upload. The row
            will show the failure message.
          </li>
        </Ol>
      </Section>

      <Section title="Read your submissions" icon={<Clock className="size-4" />}>
        <P>
          The <strong>Your screenshot submissions</strong> section shows everything you sent in.
          Each row has the request status, the analysis phase, the coordinates Cairn found for A and
          B, any warnings, and the submission time. Pending rows can be withdrawn while an admin has
          not approved or rejected them yet.
        </P>

        <ImageFigure
          src={submissionsSectionImg}
          alt="Your screenshot submissions list showing pending, approved, and rejected requests with analysis status, coordinates, warnings, and withdraw buttons."
          caption="Use the submissions list to see whether analysis is still running, which coordinates were found, and whether the request has warnings."
        />

        <StatusGrid>
          <MiniCard heading="Pending" badge={<Badge variant="outline">waiting</Badge>}>
            The request is still in review. If analysis is queued or analysing, wait for it to
            finish. If you notice the wrong files were uploaded, withdraw and submit a corrected
            pair.
          </MiniCard>
          <MiniCard
            heading="Approved"
            badge={<Badge className="bg-emerald-600 hover:bg-emerald-600">live</Badge>}
          >
            An admin accepted the pair and Cairn added the TL link to the map.
          </MiniCard>
          <MiniCard heading="Rejected" badge={<Badge variant="destructive">closed</Badge>}>
            The request was not accepted. The row should include the reason, such as wrong map,
            unclear evidence, or failed validation.
          </MiniCard>
          <MiniCard heading="Warnings" badge={<Badge variant="secondary">check</Badge>}>
            Warnings do not always mean rejection, but they tell you what an admin will inspect
            closely: low minimap match score, missing OCR data, or an area missing from the server
            map.
          </MiniCard>
        </StatusGrid>
      </Section>

      <Section title="When to retry with new screenshots" icon={<HelpCircle className="size-4" />}>
        <P>
          Retake the screenshots if the coordinates are missing, if the minimap is mostly covered,
          if you accidentally uploaded the same end twice, or if the request shows a wrong-map style
          warning and you know the shared TOPS map should already include that area. Retaking from a
          slightly more zoomed-out minimap often gives the matcher more terrain features to compare.
        </P>
        <Callout tone="warning">
          If the area has not been explored on the shared TOPS map yet, a correct screenshot may
          still warn because there is no server-map crop to compare against. In that case, the
          screenshot can still be reviewed by an admin, but a map-cache contribution for that area
          will make future checks stronger.
        </Callout>
      </Section>

      <Separator />

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <p className="font-medium text-foreground">Ready to submit a screenshot pair?</p>
            <p className="text-muted-foreground">
              Take one full HUD screenshot at each repaired TL endpoint, then open Contribute TLs.
            </p>
          </div>
          <NavLink to="/multiplayer/contribute-tls">
            <Button>
              <Send className="mr-1.5 size-4" />
              Open Contribute TLs
            </Button>
          </NavLink>
        </CardContent>
      </Card>
    </div>
  );
}

function Lede({ children }: { children: ReactNode }) {
  return (
    <p className="border-l-2 border-primary/40 pl-3 text-base leading-relaxed text-foreground/90">
      {children}
    </p>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
        {icon ? <span className="text-primary">{icon}</span> : null}
        {title}
      </h2>
      <div className="space-y-3 text-muted-foreground">{children}</div>
    </section>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p>{children}</p>;
}

function Ul({ children }: { children: ReactNode }) {
  return <ul className="list-disc list-outside space-y-1.5 pl-5">{children}</ul>;
}

function Ol({ children }: { children: ReactNode }) {
  return <ol className="list-decimal list-outside space-y-1.5 pl-5">{children}</ol>;
}

function Checklist({ children }: { children: ReactNode }) {
  return <ul className="list-disc list-outside space-y-2 pl-5">{children}</ul>;
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
      {children}
    </code>
  );
}

function Callout({ tone, children }: { tone: "info" | "warning"; children: ReactNode }) {
  const cls =
    tone === "warning"
      ? "border-amber-300 bg-amber-50 text-amber-900"
      : "border-sky-300 bg-sky-50 text-sky-900";
  return <div className={`rounded border ${cls} p-3 text-xs`}>{children}</div>;
}

function ImageFigure({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="space-y-2">
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="block overflow-hidden rounded border bg-muted/40"
      >
        <img src={src} alt={alt} loading="lazy" className="h-auto w-full" />
      </a>
      <figcaption className="text-center text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}

function StatusGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}

function MiniCard({
  heading,
  badge,
  children,
}: {
  heading: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5 rounded border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{heading}</p>
        {badge}
      </div>
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  );
}
