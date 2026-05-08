import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  CheckCircle2,
  FileText,
  HelpCircle,
  Link2,
  MapPinned,
  MousePointer2,
  Send,
  Upload,
} from "lucide-react";
import parseExampleImg from "@/assets/ContributeTLsParseExample.png";
import previewExampleImg from "@/assets/ContributeTLsPreviewExample.png";

export function AddingTranslocatorsWithContributeTLsPost() {
  return (
    <div className="space-y-6 text-sm leading-relaxed">
      <Lede>
        The <strong>Contribute TLs</strong> page turns your in-game translocator waypoints into
        map-ready pairs. You give it your <Code>client-chat.log</Code>, it pulls out only spiral
        waypoints, compares them with the existing TOPS translocator layer, and gives you a review
        screen where you can confirm, fix, or remove entries before they go live. You only need a
        Cairn account so your own TLs can be reverted cleanly later and abusive submissions are
        easier to stop; your public contributor name can still stay anonymous.
      </Lede>

      <Section title="Before you start" icon={<FileText className="size-4" />}>
        <P>
          Create or sign in to a Cairn account before submitting. This does not mean your name has
          to be public: you can keep your contribution anonymous while still letting Cairn know
          which account owns the submitted TLs. That ownership makes it possible for the same user
          to revert their own contribution later and gives admins a practical way to limit abuse.
        </P>
        <P>
          Open Vintage Story on the server where your translocator waypoints live, then type this in
          chat:
        </P>
        <Pre>{`/waypoint list details`}</Pre>
        <P>
          The command prints your full waypoint list into chat. It is only visible to you, but it is
          also written into <Code>client-chat.log</Code>, which is the file Cairn needs for TL
          contributions.
        </P>
        <Callout>
          Only waypoints using the <Code>spiral</Code> icon are read. Bases, notes, landmarks, and
          other custom waypoint types are ignored and never uploaded.
        </Callout>
        <Callout>
          Automatic pairing only works when each translocator waypoint label includes the
          approximate X/Z coordinates of the other end. The coordinates do not need to be exact, but
          both labels need to point near their matching exits for Cairn to link the pair by itself.
        </Callout>
      </Section>

      <Section title="Step 1: upload your chat log" icon={<Upload className="size-4" />}>
        <P>
          Go to the{" "}
          <NavLink
            to="/multiplayer/contribute-tls"
            className="underline decoration-dotted underline-offset-2 hover:text-primary"
          >
            Contribute TLs page
          </NavLink>
          . The upload card shows the usual log locations for Windows, Linux, and macOS. On Windows,
          the file is normally here:
        </P>
        <Pre>{`%appdata%\VintagestoryData\Logs\client-chat.log`}</Pre>
        <P>
          Choose <Code>client-chat.log</Code>, click <strong>Parse file</strong>, and wait for the
          summary. If the page says it found no spiral waypoints, run{" "}
          <Code>/waypoint list details</Code> in-game again and upload the updated log.
        </P>

        <ImageFigure
          src={parseExampleImg}
          alt="Contribute TLs upload card after parsing a client-chat.log file."
          caption="After parsing, the upload card shows how many total waypoints were found, how many are translocators, and how many look new, existing, or unpaired."
        />
      </Section>

      <Section title="Step 2: read the parse summary" icon={<CheckCircle2 className="size-4" />}>
        <P>The summary gives you a quick sense of how much cleanup the batch needs:</P>
        <Ul>
          <li>
            <strong>Already on the map</strong> means Cairn recognized both endpoints as an existing
            server-known translocator. These stay visible for reference, but are skipped when you
            submit.
          </li>
          <li>
            <strong>New pairs</strong> are the TLs Cairn thinks can be submitted. Some may still
            need review if their waypoint labels point near more than one possible partner.
          </li>
          <li>
            <strong>Unpaired</strong> entries have only one usable endpoint. You will need to link
            them, type the missing partner coordinates, remove them, or ignore them.
          </li>
        </Ul>
        <P>
          When the numbers look reasonable, click <strong>Continue to review</strong>.
        </P>
      </Section>

      <Section title="Step 3: review the map" icon={<MapPinned className="size-4" />}>
        <P>
          The review screen has the TOPS map on the left and your parsed translocators on the right.
          Click a row to zoom the map to that TL. Click an endpoint on the map to select the
          matching row. The colors match the review status, so you can scan for the entries that
          need action.
        </P>

        <ImageFigure
          src={previewExampleImg}
          alt="Contribute TLs review page with the TOPS map, colored translocator lines, and grouped review list."
          caption="The review page is where you confirm clear pairs, fix ambiguous ones, and remove entries that cannot be submitted."
        />
      </Section>

      <Section title="What each status means" icon={<HelpCircle className="size-4" />}>
        <StatusGrid>
          <StatusCard label="New - confirmed" variant="default">
            Cairn found a clear partner for the waypoint. These are ready to submit as-is.
          </StatusCard>
          <StatusCard label="New - needs review" variant="secondary">
            There were multiple possible partners nearby. Confirm the pairing, edit it, drag a map
            handle, or use Link two TLs before submitting.
          </StatusCard>
          <StatusCard label="Unpaired" variant="destructive">
            The entry is missing a partner. Link it to another endpoint, type endpoint B manually,
            or remove it if you only have one side.
          </StatusCard>
          <StatusCard label="Invalid" variant="destructive">
            Something is wrong, such as duplicate coordinates or an entry that was merged into
            another TL. Fix it or remove it.
          </StatusCard>
          <StatusCard label="Already on map" variant="outline">
            Both endpoints match a known TL. These are skipped at submit-time and shown only so you
            know Cairn recognized them.
          </StatusCard>
        </StatusGrid>
      </Section>

      <Section title="Fix pairings before submitting" icon={<Link2 className="size-4" />}>
        <P>
          Most contributions only need a quick skim, but the review page gives you a few tools when
          a pair is uncertain:
        </P>
        <Callout>
          Cairn can only auto-link two ends when the label on each spiral waypoint contains the
          approximate coordinates of the opposite end. If one side is missing that coordinate hint,
          expect to link or edit the pair manually.
        </Callout>
        <Ul>
          <li>
            Use the check button on a <strong>New - needs review</strong> row when the suggested
            pairing is correct.
          </li>
          <li>
            Click the pencil button to edit endpoint A or endpoint B coordinates. Y is ignored; only
            X and Z matter.
          </li>
          <li>
            Turn on <strong>Show pairing candidates</strong> to display likely partner endpoints for
            the selected TL.
          </li>
          <li>
            Click <strong>Link two TLs</strong>, then click two endpoint handles on the map to merge
            two one-sided entries into a pair.
          </li>
          <li>
            Drag a square endpoint handle if the parsed coordinate is slightly off. Handles snap to
            existing user-TL endpoints when they are close enough.
          </li>
        </Ul>
        <Callout>
          If you are unsure what to fix, click <strong>What to do now?</strong> on the review page.
          It explains each status group and the expected action for that group.
        </Callout>
      </Section>

      <Section title="Step 4: submit" icon={<Send className="size-4" />}>
        <P>
          When the batch is ready, click <strong>Submit contribution</strong>. The confirmation
          dialog shows how many confirmed and review-needed TLs will be submitted, plus how many
          entries will be skipped because they are unpaired, invalid, or already on the map.
        </P>
        <P>
          Submittable TLs go live immediately after the backend accepts them. The map overlay is
          refreshed so you can see the new blue translocator lines without leaving the page.
        </P>
      </Section>

      <Separator />

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <p className="font-medium text-foreground">Ready to add TLs?</p>
            <p className="text-muted-foreground">
              Run <Code>/waypoint list details</Code>, grab <Code>client-chat.log</Code>, and open
              the Contribute TLs page.
            </p>
          </div>
          <NavLink to="/multiplayer/contribute-tls">
            <Button>
              <MousePointer2 className="mr-1.5 size-4" />
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

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
      {children}
    </code>
  );
}

function Pre({ children }: { children: ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded border bg-muted/40 p-3 font-mono text-xs text-foreground">
      {children}
    </pre>
  );
}

function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-sky-300 bg-sky-50 p-3 text-xs text-sky-900">
      {children}
    </div>
  );
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

function StatusCard({
  label,
  variant,
  children,
}: {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
  children: ReactNode;
}) {
  return (
    <div className="space-y-2 rounded border bg-card p-3">
      <Badge variant={variant}>{label}</Badge>
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  );
}
