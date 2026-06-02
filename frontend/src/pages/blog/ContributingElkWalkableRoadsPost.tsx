import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AlertTriangle, Clock, Footprints, Settings2, Sparkles, Upload } from "lucide-react";
import preferToggleImg from "@/assets/Guides/Elk-roads/PreferElkWalkableRoutes.png";
import estimateImg from "@/assets/Guides/Elk-roads/EstimateTimeWithElkWalkableRouteSetting.png";
import tooltipImg from "@/assets/Guides/Elk-roads/RouteEstimateTimeWithTooltip.png";
import submitImg from "@/assets/Guides/Elk-roads/SubmitContributionsElkRoad.png";

export function ContributingElkWalkableRoadsPost() {
  return (
    <div className="space-y-6 text-sm leading-relaxed">
      <Lede>
        Elk mounts are fast on roads but they can't cross chasms, shores, or acid. The route planner
        already knows where translocators connect — but only the community knows which walking
        shortcuts an elk can actually take. This guide walks through how the elk preference shapes
        your route, how to read the time estimates, and how to attest a walk leg as elk-walkable so
        other players benefit from your verification.
      </Lede>

      <Section title="Turn on the elk preference" icon={<Settings2 className="size-4" />}>
        <P>
          In the Route planner, scroll to <strong>TL penalty</strong> and toggle on{" "}
          <strong>Prefer elk-walkable routes</strong>. The planner will now strongly favor walking
          shortcuts that other players have confirmed an elk can cross.
        </P>

        <ImageFigure
          src={preferToggleImg}
          alt="Route planner showing the TL penalty slider at 19s and the Prefer elk-walkable routes toggle in the on position, with the explanatory help text below."
          caption='Toggle on "Prefer elk-walkable routes". Unverified shortcuts still appear, but with a large time penalty so verified chains win when reasonable.'
        />

        <Callout tone="info">
          The <strong>TL penalty</strong> right above is a separate knob — fixed time cost per
          translocator hop (charge-up, possible ladder climbing). Both interact when the planner
          ranks alternatives.
        </Callout>
      </Section>

      <Section title="Read the time estimate" icon={<Clock className="size-4" />}>
        <P>
          With the elk preference on, each route alternative shows an{" "}
          <strong>estimated time range</strong> instead of a single number. The lower bound assumes
          every walk on the route is elk-walkable; the upper bound assumes every unverified walk
          needs extra effort.
        </P>

        <ImageFigure
          src={estimateImg}
          alt="Route alternative #2 selected showing 1345 blocks across 2 TLs with an estimated time of 3m 50s to 5m 50s and a walk leg flagged with + up to 2m 0s if unverified."
          caption="Each unverified walk leg is tagged with a + up to X badge. That extra time is what gets added if it turns out an elk can't actually cross that segment."
        />

        <Checklist>
          <li>
            <strong>Best (lower bound):</strong> every walk leg is treated as elk-walkable.
          </li>
          <li>
            <strong>Worst (upper bound):</strong> every unverified walk leg costs the full penalty.
          </li>
          <li>
            <strong>Confirmed legs</strong> have no badge — they're already attested by the
            community.
          </li>
        </Checklist>
      </Section>

      <Section title="Mark a walk leg as elk-walkable" icon={<Footprints className="size-4" />}>
        <P>
          Next to each walk leg in the route breakdown there's a small paw button. Hover it to see{" "}
          <strong>Mark this walk as elk-walkable</strong>. Click it to add an attestation to your
          local draft — the leg turns into a pending contribution and shows up in the{" "}
          <strong>Elk-walkable contributions</strong> card below the route.
        </P>

        <ImageFigure
          src={tooltipImg}
          alt="Route alternative #3 showing the Mark this walk as elk-walkable tooltip on the paw button next to a walk leg, with the Elk-walkable contributions card visible below listing color legend entries Confirmed, Unconfirmed, Marking elk-walkable, Removing my attestation."
          caption="The paw button queues a local attestation. Below the route, the Elk-walkable contributions card shows the legend and your draft state."
        />

        <StatusGrid>
          <MiniCard
            heading="Confirmed"
            badge={<Badge className="bg-emerald-600 hover:bg-emerald-600">verified</Badge>}
          >
            At least one player has already attested this walk. The planner trusts these legs at
            full elk speed.
          </MiniCard>
          <MiniCard heading="Unconfirmed" badge={<Badge variant="outline">no data</Badge>}>
            Nobody has attested this walk yet. The planner shows it but applies the unverified
            penalty.
          </MiniCard>
          <MiniCard heading="Marking elk-walkable" badge={<Badge variant="secondary">draft</Badge>}>
            You've queued this leg as elk-walkable in your local draft. It only counts once you
            submit.
          </MiniCard>
          <MiniCard
            heading="Removing my attestation"
            badge={<Badge variant="secondary">draft</Badge>}
          >
            You previously attested this leg and now want to take it back. Also queued until you
            submit.
          </MiniCard>
        </StatusGrid>

        <Callout tone="info">
          Only walks that are part of a fully-id-stamped route can be marked. If the paw button is
          hidden, one of the endpoints is a virtual node (e.g. start/end) or hasn't been assigned a
          stable id yet.
        </Callout>
      </Section>

      <Section title="Submit your contributions" icon={<Upload className="size-4" />}>
        <P>
          Once you've queued one or more walks, the <strong>Submit contributions</strong> button at
          the bottom of the card becomes active. Each draft entry shows the two endpoints so you can
          double-check what you're attesting before sending it.
        </P>

        <ImageFigure
          src={submitImg}
          alt="Two queued walk attestations between coordinate-stamped endpoints, with Submit contributions and Clear draft buttons below."
          caption="A typical draft: two walks queued for attestation. Use Clear draft to abandon them, or Submit contributions to send them to the server."
        />

        <Checklist>
          <li>
            <strong>Submit contributions</strong> uploads every queued attestation and removal in
            one request. On success you'll see a "Submitted N changes. Thanks!" line.
          </li>
          <li>
            <strong>Clear draft</strong> drops every pending change locally — nothing is sent.
          </li>
          <li>
            Submitting requires a Cairn account. Anonymous users can use the elk preference but
            can't attest.
          </li>
        </Checklist>
      </Section>

      <Section title="Good elk-walkable etiquette" icon={<AlertTriangle className="size-4" />}>
        <Checklist>
          <li>
            <strong>Only attest walks you've actually ridden.</strong> "Looks fine on the map" is
            not enough — chasms, single-block shores, and acid lakes can hide between chunks.
          </li>
          <li>
            <strong>Remove your attestation</strong> if a route stops working (terrain change, world
            update). Click the paw button on a confirmed leg to queue a removal.
          </li>
          <li>
            <strong>Smaller legs are more useful.</strong> Long walks reused across many routes give
            the planner more flexibility once verified.
          </li>
          <li>
            <strong>Don't spam the same chain.</strong> One attestation per leg per account is
            enough — the planner already trusts confirmed legs at full speed.
          </li>
        </Checklist>
      </Section>

      <Separator />

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <p className="font-medium text-foreground">Ready to verify a shortcut?</p>
            <p className="text-muted-foreground">
              Open the TOPS Map, plan a route, and look for the paw button next to a walk leg.
            </p>
          </div>
          <NavLink to="/multiplayer/tops-map">
            <Button>
              <Sparkles className="mr-1.5 size-4" />
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

function Checklist({ children }: { children: ReactNode }) {
  return <ul className="list-disc list-outside space-y-2 pl-5">{children}</ul>;
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
