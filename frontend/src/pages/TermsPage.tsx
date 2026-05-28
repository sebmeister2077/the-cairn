import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "@/lib/i18n";
import { TermsPageRu } from "./TermsPage.ru";

const LAST_UPDATED = "May 15, 2026";
const CONTACT_EMAIL = "vswaypoint.jokingly672@passinbox.com";

export function TermsPage() {
  const { locale } = useTranslation();
  if (locale === "ru") return <TermsPageRu />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Terms of Use</CardTitle>
        <p className="text-xs text-muted-foreground">Last updated: {LAST_UPDATED}</p>
      </CardHeader>
      <CardContent className="space-y-6 text-sm leading-relaxed text-muted-foreground">
        <section className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
          <strong>Draft notice.</strong> These terms describe how the operator expects the Service
          to be used. They are not legal advice. Questions:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
            {CONTACT_EMAIL}
          </a>
          .
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">1. Acceptance</h2>
          <p>
            By accessing or using Cairn (the “Service”), you agree to be bound by these Terms of Use
            and our{" "}
            <a href="/privacy" className="underline">
              Privacy Policy
            </a>
            . If you do not agree, do not use the Service.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">2. Eligibility</h2>
          <p>You must be at least 13 years old (16 in the EU) to use the Service.</p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">3. API keys and accounts</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>Access is invite-only. API keys are issued at the operator's discretion.</li>
            <li>
              You are responsible for keeping your API key confidential. Treat it like a password.
            </li>
            <li>
              On first use, your API key is automatically bound to a one-way hash of the IP address
              it was used from. This binding is used by the operator to detect alt accounts and to
              enforce IP-level bans. See the{" "}
              <a href="/privacy" className="underline">
                Privacy Policy
              </a>{" "}
              for details.
            </li>
            <li>
              An <strong>account profile</strong> is created for you the first time you use the
              Service. It includes an auto-generated public display name and optional fields you
              control (in-game name, hireable status, leaderboard visibility). You may regenerate
              your display name a limited number of times, change your in-game name, export your
              data, or delete your account at any time from the <strong>Account</strong> page.
              Account deletion is a soft-delete: your profile is anonymised and your API key is
              revoked, but contributions you made to the community map remain in the shared dataset
              under the anonymised display name.
            </li>
            <li>
              The operator may revoke any key, regenerate any display name, or soft-delete any
              account at any time, with or without notice, for abuse, suspected unauthorised use, or
              any other reason.
            </li>
            <li>
              You must not share your key publicly, use it on behalf of users to whom you have not
              been authorised to delegate access, create alt accounts to evade rate limits or bans,
              or impersonate another user via your display name or in-game name.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">4. Acceptable use</h2>
          <p>You agree not to:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Upload malware, illegal content, or files you do not have the right to share.</li>
            <li>
              Upload save files or map data that belong to other players without their permission.
            </li>
            <li>
              Attempt to circumvent rate limits, scrape the Service, or carry out denial-of-service
              attacks.
            </li>
            <li>Reverse-engineer, probe, or attack the infrastructure or other users' data.</li>
            <li>
              Use the Service to violate Vintage Story's EULA or any third party's intellectual
              property rights.
            </li>
            <li>
              Use the Service as a channel to transmit messages, communications, advertisements, or
              any other information of any kind to other users or to the public — including, but not
              limited to, embedding such content in your account display name, in-game name (IGN),
              waypoint titles, or any other free-text field. The Service is a tool for map and
              waypoint data, not a messaging platform. The operator may, at its sole discretion and
              depending on the nature of the content, edit or remove the offending field, revoke
              your API key, and ban your account without notice.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">5. Rate limits</h2>
          <p>
            The Service applies rate limits (currently 5 requests per hour per key, by default) to
            prevent abuse. Limits may change at any time without notice.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">
            6. Community map contributions
          </h2>
          <p>
            When you submit a map cache file via the <strong>Contribute</strong> tool:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              You warrant that you have the right to upload the data and that doing so does not
              infringe anyone else's rights.
            </li>
            <li>
              You grant the operator a{" "}
              <strong>
                perpetual, irrevocable, worldwide, royalty-free, sublicensable licence
              </strong>{" "}
              to host, display, modify, merge, and redistribute the contributed data as part of the
              shared community map.{" "}
              <strong>Redistribution may take any form the operator chooses</strong>, including,
              without limitation: rendered map images served on this Service, machine-readable map
              chunks, statistical summaries, and — if and when such a feature is offered — raw or
              merged map-cache database files (e.g. <code>.db</code> downloads) that other users may
              load into their own game client.
            </li>
            <li>
              Approved contributions are <strong>merged irreversibly</strong> into the community map
              and cannot be withdrawn. Please be sure before you contribute.
            </li>
            {/* <li>
                            <strong>Server operators:</strong> if a
                            contribution containing data from a server you
                            operate was uploaded without your consent and you
                            want it removed from the community dataset,
                            email{" "}
                            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
                                {CONTACT_EMAIL}
                            </a>
                            {" "}with enough information to identify the
                            server (e.g. server name, IP, or a sample
                            contribution ID) and we will review the request.
                        </li> */}
            <li>
              The operator may reject, delete, or roll back pending contributions at any time
              without notice.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">7. Intellectual property</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              The Service, including its source code, design, and content, is the proprietary
              property of the operator. <strong>All rights reserved.</strong> No licence, express or
              implied, is granted to you to copy, modify, distribute, sublicense, reverse engineer,
              or create derivative works of the Service or its source code, except as expressly
              permitted by the operator in writing or by applicable law.
            </li>
            <li>
              Your right to use the Service is a limited, personal, non-transferable, non-exclusive,
              and revocable permission to access the hosted Service in accordance with these Terms.
              It does not transfer any ownership of the Service to you.
            </li>
            <li>
              “Vintage Story” is a trademark of Anego Studios. This Service is an unofficial fan
              project and is not affiliated with or endorsed by Anego Studios.
            </li>
            <li>
              <strong>No decompiled game code was used to build this Service.</strong> All
              file-format handling (waypoint <code>.vcdbs</code> saves and multiplayer map{" "}
              <code>.db</code> caches) was developed by inspecting the byte layout of the files
              those formats produce on disk — i.e. the output of the user's own game client — and by
              referring to publicly available community documentation. The Service contains no game
              assets (textures, models, sounds, official asset JSONs) and no code copied or
              translated from decompiled <em>Vintage Story</em> binaries.
            </li>
            <li>
              The community-map dataset's licence is to be confirmed; until specified, treat it as
              “all rights reserved by the operator and contributors collectively” for redistribution
              purposes.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">8. Disclaimer of warranties</h2>
          <p>
            The Service is provided <strong>“AS IS” and “AS AVAILABLE”</strong>, without warranties
            of any kind, express or implied. The operator does not warrant that the Service will be
            uninterrupted, error-free, or that uploads, merges, or generated files will be accurate
            or preserved.
          </p>
          <p>
            <strong>
              Always back up your save files before using Import, Delete, or any tool that modifies
              them.
            </strong>
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">9. Limitation of liability</h2>
          <p>
            To the maximum extent permitted by law, the operator is not liable for any direct,
            indirect, incidental, special, consequential, or punitive damages arising from your use
            of the Service, including but not limited to save-file corruption, lost waypoints, lost
            map data, or service downtime.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">10. Indemnification</h2>
          <p>
            You agree to indemnify and hold harmless the operator from any claims, damages, or
            expenses arising from content you upload or from your breach of these Terms.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">11. Termination</h2>
          <p>
            The operator may suspend or terminate your access to the Service at any time, with or
            without notice, for any reason, including breach of these Terms.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">12. Governing law</h2>
          <p>
            These Terms are governed by the laws of Romania, without regard to its conflict-of-laws
            rules. Any dispute arising out of or in connection with these Terms or your use of the
            Service will be subject to the exclusive jurisdiction of the competent courts of
            Romania.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">13. Changes to these Terms</h2>
          <p>
            We may update these Terms. Material changes will bump both the consent banner version
            and the server-side terms version recorded on your account, prompting you to re-accept
            on your next visit. The “Last updated” date at the top of this page reflects the most
            recent revision. Continued use after changes means you accept the new Terms.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">14. Contact</h2>
          <p>
            Questions:{" "}
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
