import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const LAST_UPDATED = "May 25, 2026";
const CONTACT_EMAIL = "vswaypoint.jokingly672@passinbox.com";

export function PrivacyPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Privacy Policy</CardTitle>
        <p className="text-xs text-muted-foreground">Last updated: {LAST_UPDATED}</p>
      </CardHeader>
      <CardContent className="space-y-6 text-sm leading-relaxed text-muted-foreground">
        <section className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
          <strong>Draft notice.</strong> This policy is a good-faith description of how the service
          handles data, written by the operator. It is not legal advice. If you have questions,
          contact us at{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
            {CONTACT_EMAIL}
          </a>
          .
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">1. Who we are</h2>
          <p>
            Cairn (the “Service”) is an unofficial, fan-made web toolkit for the game{" "}
            <em>Vintage Story</em>. It is operated as a hobby project. For privacy questions,
            contact{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
          <p>
            The Service is not affiliated with or endorsed by Anego Studios, the developer of
            Vintage Story.
          </p>
          <p>
            The Service was built by inspecting the byte layout of the save and map-cache files that{" "}
            <em>Vintage Story</em> writes to disk on the user's own machine, plus publicly available
            community documentation. <strong>No decompiled game code was used</strong> and the
            Service contains no game assets.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">
            2. Data stored in your browser
          </h2>
          <p>
            We use your browser's <strong>local storage</strong> to keep the Service working. We do{" "}
            <strong>not</strong> use third-party tracking cookies, advertising cookies, or
            third-party analytics services (no Google Analytics, no Plausible, no pixels, etc.). We
            do keep a first-party usage log on our own backend &mdash; see section 4c. The specific
            items saved in your browser may change over time as features are added, changed, or
            removed. Examples of what may be stored include:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Your <strong>API key</strong>, which both authenticates your requests and identifies
              your account.
            </li>
            <li>
              Your permission state (e.g. admin, contributor), so the interface can show the tools
              available to you without an extra round-trip.
            </li>
            <li>Whether you accepted this notice, so we do not need to show it on every visit.</li>
            <li>
              Quality-of-life preferences and cached data, such as recently fetched map information
              or your last viewed map state, so the app loads faster and feels consistent when you
              return.
            </li>
          </ul>
          <p>
            You can clear this data at any time using your browser's site-data controls. Doing so
            will sign you out and reset your preferences.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">3. Data you upload</h2>
          <p>Several tools accept file uploads. We treat them in two very different ways:</p>
          <h3 className="font-medium text-foreground">3.1 Files processed and discarded</h3>
          <p>
            Save files (<code className="rounded bg-muted px-1 text-xs">.vcdbs</code>), waypoint
            lists, and local map cache files (
            <code className="rounded bg-muted px-1 text-xs">.db</code>) uploaded to the Extract,
            Import, Delete, Commands, and Local Map Viewer tools are processed in memory or in
            temporary storage and are <strong>discarded immediately</strong> once the response is
            returned. We do not retain copies.
          </p>
          <h3 className="font-medium text-foreground">
            3.2 Files contributed to the community map
          </h3>
          <p>
            Files you submit through the <strong>Contribute</strong> tool are stored on Cloudflare
            R2 and reviewed by an admin. Approved contributions are{" "}
            <strong>merged irreversibly</strong> into the shared community map dataset. Once merged,
            the data cannot be individually identified or removed because it is combined with
            contributions from other users. Pending contributions that are rejected are deleted.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">
            4. Data we collect automatically
          </h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>IP address</strong> &mdash; used in memory by our rate limiter to prevent
              abuse. We do <strong>not</strong> persist your raw IP. We do persist a one-way{" "}
              <strong>HMAC-SHA256 hash</strong> of it (computed with a secret salt) so we can:
              detect when multiple accounts use the same connection (alt-account / abuse review),
              and enforce IP-level bans against accounts that violate these terms. The hash is
              non-reversible and cannot be used to recover the original IP.
            </li>
            <li>
              <strong>Standard request logs</strong> &mdash; the backend host (Render) records
              request metadata (method, path, status, IP, user-agent, timestamp). These are retained
              for the host's default log retention period.
            </li>
            <li>
              <strong>API key</strong> &mdash; sent on every request via the{" "}
              <code className="rounded bg-muted px-1 text-xs">X-API-Key</code> header so we can
              authenticate you.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">4a. Your account profile</h2>
          <p>When you first use an API key, we create an account for you. The account stores:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              An auto-generated <strong>display name</strong> (e.g. <em>Bright-Explorer-1234</em>).
              You do not pick it; we generate it for you and you can ask for a new random one. It is
              shown publicly next to any contribution you make.
            </li>
            <li>
              An optional <strong>in-game name</strong> that you can set yourself, used on opt-in
              leaderboards and to identify you to other players.
            </li>
            <li>
              Opt-in flags you control: whether you appear on the public <strong>hireable</strong>{" "}
              list, on the public <strong>leaderboard</strong>, and whether your contribution stats
              are shown publicly.
            </li>
            <li>
              The version of the Terms you accepted, when you accepted them, and when your account
              was created.
            </li>
            <li>
              A flag indicating whether your account was the first one ever created on its IP hash
              (used by admins to distinguish original accounts from alts behind the same
              connection).
            </li>
          </ul>
          <p>
            We do <strong>not</strong> ask for, and do not store, an email, password, real name, or
            any other identifier beyond what is listed above.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">4b. Moderation records</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>User flags</strong> &mdash; the system automatically records review flags such
              as &ldquo;another account exists on this IP hash&rdquo; or &ldquo;your in-game name
              collides with another user's&rdquo;. Admins can resolve these as valid, abusive, or
              dismissed. Flags do not block your access on their own.
            </li>
            <li>
              <strong>IP-hash bans</strong> &mdash; if your connection is banned for abuse, the ban
              is stored against the IP hash (not the raw IP) together with the reason code, admin
              notes, and expiry.
            </li>
            <li>
              <strong>Admin audit log</strong> &mdash; an append-only log of moderation actions
              (bans, account deletions, name regenerations, re-keys, flag resolutions) for
              accountability.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">4c. Internal usage log</h2>
          <p>
            To understand how the Service is used, spot abuse patterns, and plan capacity, the
            backend records a small <strong>usage event</strong> each time certain actions happen
            (for example: a contribution is submitted, an admin approves or rejects a contribution,
            a backup download link is redeemed, a moderation action is taken). Each event stores:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              The event type and category (e.g. <em>contribution.submitted</em>).
            </li>
            <li>A timestamp (UTC).</li>
            <li>
              The opaque identifier of the API key that performed the action (the same identifier
              already tied to your account profile &mdash; never the raw key itself).
            </li>
            <li>
              A small JSON metadata blob with non-identifying context such as the affected
              contribution id, landmark id, or tile count.
            </li>
            <li>
              For backup-link redemptions, the same <strong>IP hash</strong> described in section 4
              (never the raw IP).
            </li>
          </ul>
          <p>
            This log is visible only to admins through an internal dashboard and is{" "}
            <strong>never shared with third parties</strong>. It is retained indefinitely so we can
            compare activity over time. If you delete your account, past events stay in the log but
            are no longer linked to a real display name &mdash; they remain attached only to the
            same opaque tombstone described in section 8.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">
            4d. &ldquo;Save this route for road workers&rdquo; submissions
          </h2>
          <p>
            The route planner has an optional{" "}
            <strong>&ldquo;Save this route for road workers&rdquo;</strong> button. It is only sent
            when you click it. Each submission stores:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              The route itself: start and end coordinates, optional endpoint labels you typed, the
              translocator hop chain, walk distance, travel time, and the cost-model parameters used
              to compute it.
            </li>
            <li>
              The opaque identifier of your API key if you are signed in, <strong>or</strong> the
              same one-way <strong>HMAC-SHA256 hash</strong> of your IP described in section 4 if
              you are anonymous. These are used only for 24-hour soft-deduplication (so repeatedly
              clicking the button bumps a counter instead of creating duplicates) and for
              rate-limiting.
            </li>
            <li>A timestamp (UTC).</li>
          </ul>
          <p>
            The purpose is to help map maintainers prioritise tunnels, signage, and shortcuts.
            Aggregated, anonymised totals (popular routes, popular translocator connections, an
            endpoint heatmap) are published on the always-public page at{" "}
            <code className="rounded bg-muted px-1 text-xs">/public/road-workers</code>; that public
            page does <strong>not</strong> expose API key ids or IP hashes.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">5. Server-side records</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Object storage</strong> &mdash; the community map database, pending
              contribution files, rendered preview PNGs, cached map chunks as well as waypoint data.
            </li>
            <li>
              <strong>Application database</strong> &mdash; metadata about contrib utions (id,
              status, timestamps, source filename, file size, contributor reference); an audit log
              of approved merges; the <strong>account profile</strong> fields described in section
              4a; the <strong>moderation records</strong> described in section 4b; and your API key
              bound to the hashed IP it was first used on.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">
            6. Third parties (sub-processors)
          </h2>
          <p>
            We rely on the following providers to operate the Service. They process data on our
            behalf:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Vercel</strong> &mdash; frontend hosting and CDN.
            </li>
            <li>
              <strong>Render</strong> &mdash; backend hosting.
            </li>
            <li>
              <strong>Cloudflare R2</strong> &mdash; object storage for uploaded and generated
              files.
            </li>
            <li>
              <strong>Supabase</strong> &mdash; PostgreSQL database for contribution metadata.
            </li>
          </ul>
          <p>
            We do <strong>not</strong> sell your data and do <strong>not</strong> share it for
            advertising.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">7. International transfers</h2>
          <p>
            Our providers operate globally. Your data may be processed in countries outside your
            own, including outside the EU/EEA. Where applicable, our providers use standard
            contractual clauses to safeguard transfers.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">8. Retention</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Save-file and local-map uploads (Extract / Import / Delete / Commands / Map Viewer):
              discarded immediately after processing.
            </li>
            <li>Pending community-map contributions: kept until approved or rejected.</li>
            <li>
              Approved community-map contributions: <strong>retained indefinitely</strong> as part
              of the shared map and cannot be individually withdrawn.
            </li>
            <li>
              Account profile: retained until you delete your account (see section 9). On deletion,
              your account is <strong>soft-deleted</strong>: the row is kept but your display name
              is replaced with an opaque tombstone, your in-game name and opt-in flags are cleared,
              and your API key is revoked. Any contributions you made remain in the shared map under
              the now-anonymised tombstone.
            </li>
            <li>
              IP-hash bans: kept until the configured expiry (default 365 days), then ignored. Rows
              may persist after expiry until manually purged.
            </li>
            <li>Admin audit log: retained indefinitely for accountability.</li>
            <li>
              Internal usage events (section 4c): retained indefinitely; soft-deleted accounts are
              anonymised but their past events remain in aggregate counts.
            </li>
            <li>
              Saved routes (section 4d): retained indefinitely so trends over time remain
              comparable. The actor reference (API key id or IP hash) is kept for the same reason as
              the rest of the usage log; on account deletion it becomes anonymous in the same way as
              section 4c events.
            </li>
            <li>Backend access logs: retained per the hosting provider's default policy.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">9. Your rights</h2>
          <p>
            Depending on your location (e.g. EU/UK GDPR or CCPA), you may have rights to access,
            correct, delete, restrict, or port your personal data, and to object to processing. Two
            of these rights are built into the Service:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Access / portability:</strong> the <strong>Account</strong> page in the app
              offers a one-click data export (also available via{" "}
              <code className="rounded bg-muted px-1 text-xs">GET /api/account/export</code>) that
              returns your full account profile and the metadata of your contributions in JSON.
            </li>
            <li>
              <strong>Erasure:</strong> the <strong>Account</strong> page lets you self-delete your
              account at any time (also available via{" "}
              <code className="rounded bg-muted px-1 text-xs">DELETE /api/account/me</code>), which
              performs the soft-delete described in section 8.
            </li>
          </ul>
          <p>
            For any other request (correction, restriction, objection, or questions), contact us at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
          <p>
            <strong>Important:</strong> contributions to the community map become part of an
            aggregated dataset. Once merged, an individual contribution cannot be identified or
            erased &mdash; even after you delete your account. Please consider this before
            contributing.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">10. Children</h2>
          <p>
            The Service is not directed to children under 13 (or under 16 where required by local
            law). If you believe a child has used the Service, contact us and we will remove their
            access.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">11. Security</h2>
          <p>
            Traffic is encrypted in transit with HTTPS/TLS. Access to R2 and Supabase is restricted
            to the backend service. API keys are required for all data-changing operations. No
            system is perfectly secure; please keep backups of your save files.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">12. Changes to this policy</h2>
          <p>
            We may update this policy. Material changes will bump the consent version, which will
            re-display the consent banner. The “Last updated” date at the top of this page reflects
            the most recent revision.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">13. Contact</h2>
          <p>
            Questions or requests:{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </section>
      </CardContent>
    </Card>
  );
}
