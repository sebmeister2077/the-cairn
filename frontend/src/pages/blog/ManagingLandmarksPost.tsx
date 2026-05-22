import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  AlertTriangle,
  ChevronsUpDown,
  Clock,
  MapPin,
  Pencil,
  Plus,
  Search,
  Send,
  UserPlus,
} from "lucide-react";
import createAccountImg from "@/assets/Guides/Landmarks/ContributeWaypointsCreateAccountExample.png";
import summaryCardImg from "@/assets/Guides/Landmarks/ContributeLandmarksSummaryCardExample.png";
import expandedCardImg from "@/assets/Guides/Landmarks/ContributeLandmarksExpandedCard.png";
import addPopupImg from "@/assets/Guides/Landmarks/ContributeLandmarksAddPopupExample.png";
import searchSuggestRenameImg from "@/assets/Guides/Landmarks/ContributeLandmarksSearchSuggestRenameExample.png";
import renamePendingImg from "@/assets/Guides/Landmarks/ContributeLandmarksRenamePendingExample.png";

export function ManagingLandmarksPost() {
  return (
    <div className="space-y-6 text-sm leading-relaxed">
      <Lede>
        Landmarks are named points on the shared TOPS map — bases notable ruins, meeting spots.
        Anyone with a Cairn account can add a landmark, rename their own landmarks live, or suggest
        a new label for someone else's. This guide walks through the whole flow from the TOPS Map
        page: signing in, adding a landmark, managing your list, and suggesting renames for existing
        labels.
      </Lede>

      <Section title="You need an account first" icon={<UserPlus className="size-4" />}>
        <P>
          Landmarks are tied to your Cairn account so they can be edited, renamed, or removed later.
          If you open the TOPS Map page without an account, the landmarks panel shows a friendly CTA
          in place of the management card.
        </P>

        <ImageFigure
          src={createAccountImg}
          alt="TOPS Map sidebar showing the show landmarks toggle, show traders toggle, and a create-an-account CTA above the landmark search field."
          caption='When you are signed out, the panel reads "Create an account to add traders and add/rename landmarks." Click "Go to Account →" to set one up.'
        />

        <Callout tone="info">
          You can still toggle <strong>Show landmarks</strong> and <strong>Show traders</strong> and
          use <strong>Search landmark</strong> without an account — only adding and renaming require
          signing in.
        </Callout>
      </Section>

      <Section title="The landmarks card, signed in" icon={<MapPin className="size-4" />}>
        <P>
          Once you are signed in, the CTA is replaced with the{" "}
          <strong>Landmarks added by me</strong> card. It starts collapsed and shows the number of
          landmarks you have added on the right side of the header, next to an{" "}
          <strong>+ Add</strong> button.
        </P>

        <ImageFigure
          src={summaryCardImg}
          alt="Collapsed Landmarks added by me card with a count badge of 2 and an Add button on the right."
          caption="Collapsed view. Click the row header (or the chevron) to expand it; click + Add to open the add-landmark dialog directly."
        />
      </Section>

      <Section title="Add a landmark" icon={<Plus className="size-4" />}>
        <P>
          Click <strong>+ Add</strong> to open the add-landmark dialog. Fill in a short,
          recognizable label and the absolute world coordinates of the point.
        </P>

        <ImageFigure
          src={addPopupImg}
          alt="Add a landmark dialog with a heads-up notice, label field, X and Z coordinate fields, and an optional Y field."
          caption="Add-landmark dialog. Label is required; X and Z are required integers; Y is optional."
        />

        <Checklist>
          <li>
            <strong>Label:</strong> a short human-readable name, up to 50 characters. Examples:{" "}
            <Code>Server spawn</Code>, <Code>NE outpost</Code>, <Code>Jebi's Base</Code>.
          </li>
          <li>
            <strong>X and Z:</strong> absolute world block coordinates — the same numbers shown by{" "}
            <Code>/whereami</Code> in-game. Integers only; scientific notation like <Code>1e3</Code>{" "}
            is rejected.
          </li>
          <li>
            <strong>Y (optional):</strong> add this only when the elevation is meaningful (for
            example a sky base or a deep cave). Most surface landmarks do not need it.
          </li>
        </Checklist>

        <Callout tone="warning">
          Landmarks are <em>global</em>. Once added, the landmark appears on the map for everyone
          using the TOPS map. Please only add real, useful locations and avoid duplicates or test
          entries — the dialog repeats this in an orange notice for a reason.
        </Callout>
      </Section>

      <Section title="Manage your landmarks" icon={<ChevronsUpDown className="size-4" />}>
        <P>
          Expand the card to see every landmark you have added. Each row shows the label, its
          coordinates, and its type (Base, Server, Misc, or Terminus), with a pencil icon on the
          right to rename it.
        </P>

        <ImageFigure
          src={expandedCardImg}
          alt="Expanded Landmarks added by me card with two example landmarks (Resonance Archives and Lazaret) and a Suggest a rename for any landmark search field below them."
          caption="Expanded view. Renames on landmarks you added are applied live — no admin review."
        />

        <StatusGrid>
          <MiniCard heading="Rename your own" badge={<Badge variant="secondary">live</Badge>}>
            Click the pencil on one of your rows. The new label is written to the shared landmarks
            file immediately and the map overlay reloads.
          </MiniCard>
          <MiniCard
            heading="Remove a landmark"
            badge={<Badge variant="outline">contact admin</Badge>}
          >
            Deletion is not exposed in the user UI yet. If you need a landmark removed, ask an admin
            — they can clean it up from the admin tools.
          </MiniCard>
        </StatusGrid>
      </Section>

      <Section
        title="Suggest a rename for someone else's landmark"
        icon={<Search className="size-4" />}
      >
        <P>
          Under your own landmarks, the <strong>Suggest a rename for any landmark</strong> search
          lets you find anything on the map by label and propose a better name. Type a few
          characters and matching landmarks appear with their coordinates and type.
        </P>

        <ImageFigure
          src={searchSuggestRenameImg}
          alt="Suggest a rename search field with the text 'jebi' typed in, returning a single result Jebi's Base with coordinates 1484, -20629, y=116 tagged as Base and seed."
          caption='Searching for "jebi" turns up one match: Jebi&apos;s Base. The "seed" tag means the landmark came from the seeded dataset rather than a user submission.'
        />

        <P>
          Click the pencil on any result to open the suggest-rename dialog. Because you did not add
          the landmark, your new label is queued for admin review instead of being applied live. The
          dialog confirms this with a short notice before you submit.
        </P>
      </Section>

      <Section title="Track your pending rename requests" icon={<Clock className="size-4" />}>
        <P>
          Once you submit a suggestion, a <strong>Pending rename requests</strong> section appears
          inside the expanded card with one row per request. Each row shows the original label, the
          proposed label, the submission time, and a <Badge variant="secondary">pending</Badge>{" "}
          state badge.
        </P>

        <ImageFigure
          src={renamePendingImg}
          alt='Pending rename requests row showing pending state, a timestamp, and "Jebi&apos;s Base" → "Jebi&apos;s Base Test".'
          caption="A pending request stays visible here until an admin approves or rejects it. Approved renames update the landmark on the live map."
        />

        <StatusGrid>
          <MiniCard heading="Pending" badge={<Badge variant="secondary">waiting</Badge>}>
            An admin has not reviewed your suggestion yet. The original label is still what everyone
            sees on the map.
          </MiniCard>
          <MiniCard
            heading="Approved"
            badge={<Badge className="bg-emerald-600 hover:bg-emerald-600">live</Badge>}
          >
            The rename was accepted and the landmark now shows your suggested label for every TOPS
            map user.
          </MiniCard>
          <MiniCard heading="Rejected" badge={<Badge variant="destructive">closed</Badge>}>
            The suggestion was not accepted. Common reasons: duplicate label, joke or test entry, or
            a name that does not describe the location well.
          </MiniCard>
        </StatusGrid>
      </Section>

      <Section title="Good landmark etiquette" icon={<AlertTriangle className="size-4" />}>
        <Checklist>
          <li>
            <strong>One landmark per real place.</strong> Don't add multiple pins around the same
            base; pick a sensible centre and one clear label.
          </li>
          <li>
            <strong>Names should describe the place.</strong> Prefer <Code>NE outpost</Code> or{" "}
            <Code>Spawn market</Code> over inside jokes that nobody else will recognise.
          </li>
          <li>
            <strong>Use the right type.</strong> <em>Base</em> for player bases, <em>Server</em> for
            server-wide spots (spawn, hubs), <em>Terminus</em> for translocator endpoints worth
            marking, and <em>Misc</em> for everything else.
          </li>
          <li>
            <strong>Verify coordinates before submitting.</strong> The dialog will not check that
            the point makes sense; misplaced landmarks need admin cleanup.
          </li>
        </Checklist>
      </Section>
      {/* 
      <Section title="Useful in-game commands" icon={<Pencil className="size-4" />}>
        <Ul>
          <li>
            <Code>/whereami</Code> prints your current absolute X, Y, Z — paste those into the add
            dialog directly.
          </li>
          <li>
            <Code>/tp =X =Z</Code> teleports you to absolute world coordinates if you want to
            double-check a landmark you found on the TOPS map.
          </li>
        </Ul>
      </Section> */}

      <Separator />

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <p className="font-medium text-foreground">Ready to add or rename a landmark?</p>
            <p className="text-muted-foreground">
              Open the TOPS Map and look for the landmarks card in the sidebar.
            </p>
          </div>
          <NavLink to="/multiplayer/tops-map">
            <Button>
              <Send className="mr-1.5 size-4" />
              Open TOPS Map
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
