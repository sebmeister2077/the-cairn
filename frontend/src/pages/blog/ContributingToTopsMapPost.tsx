import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Upload,
  Eye,
  Check,
  Clock,
  AlertTriangle,
  Map as MapIcon,
  HelpCircle,
  FolderSearch,
  FileCheck2,
  Loader2,
  Hourglass,
} from "lucide-react";
import contributeCardImg from "@/assets/Guides/Map/ContributeMapCardWithHighlightedFileName&Location.png";
import fileExplorerImg from "@/assets/Guides/Map/FileExplorerWindowsWithSearchedMapFile.png";
import selectedFileImg from "@/assets/Guides/Map/SelectedFileAndNameBeforeSubmit.png";
import uploadingImg from "@/assets/Guides/Map/UploadingProgressIndicator.png";
import uploadCompleteImg from "@/assets/Guides/Map/UploadCompleteAndContributionLimit.png";
import pendingAwaitingImg from "@/assets/Guides/Map/PendingContributionWithAwaitingApproval.png";
import contributionExampleImg from "@/assets/Guides/Map/ContributionExample.png";

export function ContributingToTopsMapPost() {
  return (
    <div className="space-y-6 text-sm leading-relaxed">
      <Lede>
        The TOPS map at{" "}
        <NavLink
          to="/multiplayer/tops-map"
          className="underline decoration-dotted underline-offset-2 hover:text-primary"
        >
          /multiplayer/tops-map
        </NavLink>{" "}
        is built from <strong>real player explorations</strong>. Every patch of terrain you see was
        once part of someone&rsquo;s local map cache. This guide walks through how to add yours too
        &mdash; no setup, no accounts required, and you can stay anonymous if you prefer.
      </Lede>

      <Section title="The 30-second version" icon={<MapIcon className="size-4" />}>
        <Ol>
          <li>
            Open the{" "}
            <NavLink
              to="/multiplayer/contribute"
              className="underline decoration-dotted underline-offset-2 hover:text-primary"
            >
              Contribute Map
            </NavLink>{" "}
            page and copy the <strong>Server Map ID</strong> shown at the top.
          </li>
          <li>
            Find the matching <Code>.db</Code> file in your Vintage Story data folder.
          </li>
          <li>
            Pick the file, optionally add your name, and click <strong>Upload for Review</strong>.
          </li>
          <li>
            Wait for an admin to approve. New chunks get added to the shared map on the next map
            refresh.
          </li>
        </Ol>
        <Callout tone="info">
          <strong>No sign-up needed.</strong> Cairn assigns you a contributor key automatically the
          first time you visit, so anyone can upload. Leave the name field empty to appear as{" "}
          <em>Anonymous</em>, or fill it in to take credit.
        </Callout>
      </Section>

      <Section title="Step 1 — Find your map file" icon={<FolderSearch className="size-4" />}>
        <P>
          Vintage Story keeps a separate <Code>.db</Code> file for every multiplayer server you have
          joined. The Contribute Map page tells you exactly which one to pick: the{" "}
          <strong>Server Map ID</strong> at the top of the card is the same as the file&rsquo;s name
          on disk.
        </P>

        <ImageFigure
          src={contributeCardImg}
          alt="Contribute Map Data card with the Server Map ID and the Where can I find this file? help section underlined in red."
          caption="The Server Map ID at the top of the page is the exact filename you are looking for. Open the help section just below it to see the folder path for your operating system."
        />

        <P>
          The folder is different on each operating system. If you have never opened it before,
          follow the click-by-click steps for yours:
        </P>

        <OSBlock heading="Windows">
          <Ol>
            <li>
              Press <Kbd>Windows</Kbd> + <Kbd>R</Kbd> on your keyboard. A small <strong>Run</strong>{" "}
              window opens in the bottom-left of your screen.
            </li>
            <li>
              Type (or copy-paste) exactly this and press <Kbd>Enter</Kbd>:
              <Pre>%appdata%\VintagestoryData\Maps</Pre>
            </li>
            <li>
              A File Explorer window opens directly in your Maps folder. Each file ending in{" "}
              <Code>.db</Code> is one server&rsquo;s map cache.
            </li>
          </Ol>
        </OSBlock>

        <OSBlock heading="macOS">
          <Ol>
            <li>
              Open <strong>Finder</strong> (the smiley-face icon in the dock).
            </li>
            <li>
              In the top menu bar, click <strong>Go</strong> &rarr; <strong>Go to Folder…</strong>{" "}
              (or press <Kbd>&#8679;</Kbd> + <Kbd>&#8984;</Kbd> + <Kbd>G</Kbd>).
            </li>
            <li>
              Paste this path and press <Kbd>Return</Kbd>:
              <Pre>~/Library/Application Support/VintagestoryData/Maps</Pre>
            </li>
            <li>
              Finder opens the Maps folder. Each <Code>.db</Code> file is one server&rsquo;s map
              cache.
            </li>
          </Ol>
        </OSBlock>

        <OSBlock heading="Linux">
          <Ol>
            <li>
              Open your file manager (Files, Nautilus, Dolphin &mdash; whichever your distro uses).
            </li>
            <li>
              Press <Kbd>Ctrl</Kbd> + <Kbd>L</Kbd> to focus the address bar, then paste:
              <Pre>~/.config/VintagestoryData/Maps</Pre>
              and press <Kbd>Enter</Kbd>.
            </li>
            <li>
              If you don&rsquo;t see anything, your file manager may be hiding dotfolders. Press{" "}
              <Kbd>Ctrl</Kbd> + <Kbd>H</Kbd> to show hidden files, then try again.
            </li>
          </Ol>
        </OSBlock>

        <P>
          Once the folder is open, you may see one <Code>.db</Code> file per server you have joined
          &mdash; it can get crowded. The easiest way to find the right one is to use the{" "}
          <strong>search box</strong> in the corner of your file explorer (top-right on Windows,
          top-right on macOS Finder, top of the window on most Linux file managers) and{" "}
          <strong>paste your Server Map ID into it</strong>. Only the matching file will remain on
          screen.
        </P>

        <ImageFigure
          src={fileExplorerImg}
          alt="Windows file explorer in the Maps folder, filtered by the Server Map ID, showing a single matching .db file roughly 1 GB in size."
          caption="Searching the Maps folder for the Server Map ID quickly narrows things down to a single file, even if you have a lot of servers cached."
        />

        <Callout tone="warning">
          Upload the <Code>.db</Code> map cache file &mdash; that&rsquo;s your{" "}
          <em>explored map data</em>, not a save game. Save files have different extensions and will
          be rejected.
        </Callout>
      </Section>

      <Section title="Step 2 — Pick the file and submit" icon={<FileCheck2 className="size-4" />}>
        <P>
          Back on the Contribute Map page, use the <strong>Map Database (.db)</strong> picker to
          choose the file you just found. The form shows the file size so you can confirm it loaded.
          The <strong>Your Name</strong> field is optional &mdash; leave it as <em>Anonymous</em>,
          type any display name you like, or click <strong>Use my name</strong> if you want it
          filled from your account.
        </P>

        <ImageFigure
          src={selectedFileImg}
          alt="Contribute Map form with the chosen .db file (about 1 GB), the Your Name field filled in with VintageCreeper, and the Upload for Review button active."
          caption="Once a file is selected, the size appears underneath and Upload for Review becomes clickable. The name shown here is what will appear in the public contribution history."
        />
      </Section>

      <Section title="Step 3 — While it uploads" icon={<Loader2 className="size-4" />}>
        <P>
          Click <strong>Upload for Review</strong> and a progress bar appears under the button. Map
          caches can be hundreds of megabytes, so this may take a while on a slow connection.
        </P>

        <ImageFigure
          src={uploadingImg}
          alt="Upload for Review button with a horizontal progress bar at 32% underneath, labelled Uploading."
          caption="A simple progress bar shows how far along the upload is."
        />

        <Callout tone="warning">
          <strong>Try not to interrupt the upload.</strong> A couple of things to keep in mind while
          it&rsquo;s running:
          <ul className="list-disc pl-5 mt-2 space-y-1">
            <li>
              <strong>Network changes</strong> (switching Wi-Fi, toggling a VPN, going onto
              cellular) cause the upload to retry automatically. Most of the time that&rsquo;s fine,
              but a bad enough drop can still fail it &mdash; just try again if it does.
            </li>
            <li>
              <strong>Moving around in-game</strong> while uploading means Vintage Story keeps
              writing fresh chunks into the same <Code>.db</Code> file. If the file changes during
              the upload, the transfer can abort. Staying still (or being logged out of the game) is
              the safest bet.
            </li>
          </ul>
          Either way, nothing bad happens to your local map &mdash; the file on your computer is
          never modified or corrupted by the upload.
        </Callout>
      </Section>

      <Section title="Upload complete" icon={<Check className="size-4" />}>
        <P>
          When the upload finishes you&rsquo;ll see a green confirmation along with a reminder about
          the contribution limit: <strong>one upload pending at a time</strong>, and{" "}
          <strong>at most one approved contribution every 7 days</strong>. The form locks itself
          until your pending upload is either approved, rejected, or withdrawn.
        </P>

        <ImageFigure
          src={uploadCompleteImg}
          alt="Form after a successful upload: contribution limits banner explaining one pending upload at a time and 7-day cooldown, and a green message reading Upload received — validating in background, then pending admin approval."
          caption="A clear success message plus a reminder that the form is locked until your current submission moves on."
        />
      </Section>

      <Section title="Waiting for review" icon={<Hourglass className="size-4" />}>
        <P>
          Your contribution now sits in the <strong>Pending Contributions</strong> list at the
          bottom of the page. Two things will say <em>Awaiting admin compute</em> next to it: the{" "}
          <strong>match score</strong> and the <strong>preview image</strong>.
        </P>
        <P>
          That&rsquo;s normal. Generating previews and match scores is heavy work, so admins run it
          locally in batches rather than for every upload as it arrives. Yours will get computed
          along with everyone else&rsquo;s during the next review pass.
        </P>

        <ImageFigure
          src={pendingAwaitingImg}
          alt="Pending Contributions row for VintageCreeper showing 0 chunks, a contribution ID, Match score awaiting admin compute and Awaiting admin compute messages, plus Preview paused and Withdraw buttons."
          caption='While you wait, the preview shows "Preview paused" and the score reads "awaiting admin compute". You can withdraw any time before approval to free up your slot.'
        />
      </Section>

      <Section title="What the admin sees" icon={<Eye className="size-4" />}>
        <P>
          Once an admin runs the review pass, each pending contribution gets two things added to it:
          a coloured chip describing how well it matches the existing map, and a preview image where{" "}
          <strong>green areas are the new chunks</strong> your file would add.
        </P>

        <div className="flex flex-wrap gap-1.5 my-1">
          <Badge className="bg-emerald-600 hover:bg-emerald-600">Looks like our map</Badge>
          <Badge variant="secondary">Partial match</Badge>
          <Badge variant="destructive">May be wrong file</Badge>
        </div>

        <P>
          The numbers next to the chip (<em>overlap</em> and <em>pixel-similar</em>) tell the admin
          how confident the auto-check is that your file is really from this server. From there they
          can <strong>Approve</strong>, <strong>Reject</strong>, or ask for changes.
        </P>

        <ImageFigure
          src={contributionExampleImg}
          alt="Pending Contributions list with two entries showing tile counts, Looks like our map chips, overlap percentages, and one entry with its preview open displaying green new-tile areas over existing terrain."
          caption="A reviewed contribution: tile count, match chip, overlap and similarity numbers, plus a visual preview where green is the new terrain your contribution would add."
        />
      </Section>

      <Section title="When the map actually updates" icon={<Clock className="size-4" />}>
        <P>
          Approval doesn&rsquo;t mean the public map updates the same minute. The shared TOPS map
          image is regenerated by an admin, usually <strong>about once a week</strong>. If a lot of
          fresh chunks have piled up, the admin may run it sooner, but the update isn&rsquo;t live
          or automatic. Once it does run, your contributed area becomes part of the map for
          everyone.
        </P>
      </Section>

      <Section
        title="Why a contribution might be rejected"
        icon={<AlertTriangle className="size-4" />}
      >
        <Ul>
          <li>
            <strong>Wrong file.</strong> If you uploaded something that isn&rsquo;t a Vintage Story
            map cache, or a cache from a different server, the auto-check will flag it and an admin
            will reject it.
          </li>
          <li>
            <strong>Nothing new to add.</strong> If every chunk in your file is already on the
            shared map, there&rsquo;s nothing to merge.
          </li>
          <li>
            <strong>Doesn&rsquo;t match this server.</strong> A red <em>May be wrong file</em> chip
            usually means the file is from another server entirely &mdash; double-check the Server
            Map ID at the top of the page against your filename.
          </li>
        </Ul>
        <P>
          By default, your contribution only <strong>fills gaps</strong> in the shared map &mdash;
          it never overwrites chunks that already exist. So you can&rsquo;t accidentally damage
          someone else&rsquo;s work just by uploading.
        </P>
      </Section>

      <Section title="After approval" icon={<HelpCircle className="size-4" />}>
        <P>
          Approved contributions appear in the public <strong>Recent Contributions</strong> list for
          a couple of weeks, with the name you chose (or <em>Anonymous</em>) and the number of
          chunks added. If something goes wrong later, an admin can revert any individual
          contribution &mdash; nothing is permanent if a mistake slips through.
        </P>
        <P>That&rsquo;s it &mdash; thanks for helping fill in the map.</P>
      </Section>

      <Separator />

      <Card>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between p-4">
          <div className="text-sm">
            <p className="font-medium text-foreground">Ready to upload?</p>
            <p className="text-muted-foreground">
              Head to the Contribute Map page and grab your Server Map ID.
            </p>
          </div>
          <NavLink to="/multiplayer/contribute">
            <Button>
              <Upload className="size-4 mr-1.5" />
              Open Contribute Map
            </Button>
          </NavLink>
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------- small presentational helpers (post-local) ---------- */

function Lede({ children }: { children: ReactNode }) {
  return (
    <p className="text-base text-foreground/90 leading-relaxed border-l-2 border-primary/40 pl-3">
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

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono text-foreground">
      {children}
    </code>
  );
}

function Pre({ children }: { children: ReactNode }) {
  return (
    <pre className="my-1.5 overflow-x-auto rounded border bg-muted/40 p-2 text-xs font-mono text-foreground whitespace-pre-wrap break-all">
      {children}
    </pre>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono font-medium text-foreground shadow-sm">
      {children}
    </kbd>
  );
}

function OSBlock({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="rounded border bg-card p-3 space-y-2">
      <p className="text-sm font-medium text-foreground">{heading}</p>
      <div className="text-xs text-muted-foreground space-y-2">{children}</div>
    </div>
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
