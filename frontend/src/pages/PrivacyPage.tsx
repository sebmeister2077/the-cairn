import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const LAST_UPDATED = "April 23, 2026";
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
            analytics. The specific items saved in your browser may change over time as features are
            added, changed, or removed. Examples of what may be stored include:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              A way to temporarily identify your browser session so we can authenticate requests,
              remember your access, and help prevent abuse.
            </li>
            <li>
              Your permission state, so the interface can show the tools available to you without an
              extra round-trip.
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
              abuse. It is not persisted to a database.
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
          <h2 className="text-base font-semibold text-foreground">5. Server-side records</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Object storage</strong> &mdash; the community map database, pending
              contribution files, rendered preview PNGs, and cached map chunks.
            </li>
            <li>
              <strong>Application database</strong> &mdash; metadata about contributions (id,
              status, timestamps, source filename, file size, contributor reference) and an audit
              log of approved merges.
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
            <li>Backend access logs: retained per the hosting provider's default policy.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">9. Your rights</h2>
          <p>
            Depending on your location (e.g. EU/UK GDPR or CCPA), you may have rights to access,
            correct, delete, restrict, or port your personal data, and to object to processing. To
            exercise these rights, contact us at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
          <p>
            <strong>Important:</strong> contributions to the community map become part of an
            aggregated dataset. Once merged, an individual contribution cannot be identified or
            erased. Please consider this before contributing.
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
