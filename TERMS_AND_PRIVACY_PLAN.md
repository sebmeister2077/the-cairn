# Terms & Privacy Plan

This document outlines what the **Terms of Use** and **Privacy Policy** for the
VS Waypoint & Map Tools site need to cover, derived from how the project
actually works (see [Architecture.md](Architecture.md)).

It is **not** legal advice — use it as the structure/checklist for a lawyer or
a generator like Termly / iubenda. The content below is intentionally written
so it can be lifted into the final policy with minimal rewriting.

---

## 1. What the service does (summary for both docs)

- Web toolkit for managing **Vintage Story** save files (`.vcdbs`) and
  client map cache files (`.db`).
- Two deployments: a React SPA on **Vercel**, a FastAPI backend on **Render**.
- Access is gated by a per-user **API key** (handed out manually or via an
  invite link). The site is invite-only / closed-beta in nature.
- One feature set is purely client-side / file-conversion (extract, import,
  delete waypoints, generate commands).
- Another feature set involves **uploading map data to a shared community
  map** (the "Contribute" workflow), which means user-supplied content
  becomes part of a shared dataset.

---

## 2. Data inventory (what the Privacy Policy must list)

### 2.1 Data stored in the user's browser (local storage)

| Key | Purpose | Personal? |
|---|---|---|
| `api_key` | Authenticates every API request | Pseudonymous — identifies the account |
| `is_admin` | Cached admin flag for UI | No |
| `can_contribute` | Cached permission flag for UI | No |
| `storage_consent` | Records the cookie/storage choice | No |
| `vs-waypoints-query-cache` | TanStack Query cache (e.g. TOPS map chunk URLs) | No |
| `tops-map-selected-level` | Last-viewed map zoom level | No |

→ The Privacy Policy must say: **we use local storage, not third-party
tracking cookies, no advertising, no analytics.**

### 2.2 Data the user uploads to the backend

| Endpoint | What it receives | What is stored |
|---|---|---|
| `POST /api/extract` | A `.vcdbs` save file | Processed in memory / temp file, **not retained** |
| `POST /api/import` | A `.vcdbs` save file + waypoints | Processed in memory / temp file, **not retained** |
| `POST /api/delete` | A `.vcdbs` save file + filters | Processed in memory / temp file, **not retained** |
| `POST /api/commands` | Waypoint JSON | Processed in memory, **not retained** |
| `POST /api/mapview` | A client `.db` map cache | Processed via temp file, **not retained** |
| `POST /api/contribute` | A client `.db` map cache | **Retained**: stored in Cloudflare R2; merged into the community map after admin review |

→ The policy must distinguish **"processed and discarded"** uploads from the
**"contributed to a shared dataset"** uploads.

### 2.3 Data automatically collected by the backend

- **IP address** — used by `rate_limiter.py` for per-IP rate limiting (in
  memory, not persisted to disk).
- **Standard request logs** — uvicorn / Render access logs (method, path,
  status, IP, user-agent, timestamp). Retention follows Render defaults.
- **API key in `X-API-Key` header** — used for auth; may appear in error logs
  if logging level is verbose.

### 2.4 Data persisted server-side

| Store | Data |
|---|---|
| Cloudflare R2 | `globalservermap.db` (community map), `pending/{id}.db`, `pending/{id}.png`, `cache/tops-map-*.png` |
| Supabase Postgres — `contributions` | UUID, status, timestamps, contributor's API key reference, source filename, file size |
| Supabase Postgres — `contribution_log` | Approved-merge audit trail (tile counts, timestamps) |
| Supabase Postgres — `app_state` | Cached counters (no user data) |
| Backend env (`API_KEYS`) | The set of valid API keys |

### 2.5 Third-party processors (sub-processors list)

The Privacy Policy needs a sub-processors table:

| Provider | Role | Region | Data they see |
|---|---|---|---|
| **Vercel** | Frontend hosting + edge CDN | Global | IPs, request metadata for the SPA |
| **Render** | Backend hosting | (region you chose) | All API requests, IPs, uploaded files in transit |
| **Cloudflare R2** | Object storage | Global | Uploaded `.db` files, rendered PNG previews |
| **Supabase** | PostgreSQL hosting | (region you chose) | Contribution metadata |

---

## 3. Privacy Policy — required sections

1. **Who we are** — operator name, contact email, jurisdiction.
2. **What data we collect** — sections 2.1–2.4 above, in plain language.
3. **Why we collect it (legal basis if EU/UK users):**
   - API key + auth data → contract / legitimate interest (operating the service).
   - IP for rate limiting + logs → legitimate interest (security, abuse prevention).
   - Contributed map files → consent (the user explicitly clicks "Contribute").
4. **Cookies / browser storage** — must list the keys from §2.1 and state
   they are **strictly necessary / functional** (no consent banner is legally
   required for those alone in many jurisdictions, but we still ask).
5. **How long we keep it (retention):**
   - Save files / waypoint uploads: **discarded immediately after processing.**
   - Contributed map data: **retained indefinitely** as part of the
     community map (and may be irreversibly merged — call this out clearly).
   - Pending contributions awaiting review: until approved or rejected.
   - Logs: per Render default (state the number, e.g. 7–30 days).
6. **Who we share it with** — sub-processors table from §2.5. State that we
   do **not** sell data and do **not** share for advertising.
7. **International transfers** — Vercel / Render / R2 / Supabase may
   process data outside the EU/EEA. Mention SCCs if relevant.
8. **Your rights** (GDPR / UK-GDPR / CCPA):
   - Access, rectification, erasure, restriction, portability, objection.
   - **Important caveat:** explain that contributed map data, once merged
     into the shared community map, **cannot be individually erased** because
     it is anonymised and combined with other contributions. Users must be
     told this **before** they contribute. The contribute UI should link to
     this section.
   - How to exercise: email address.
9. **Children** — service is not directed to under-13s (or under-16s in EU).
10. **Security** — TLS in transit, R2/Supabase access controls, API key auth.
11. **Changes to this policy** — versioning + how users are notified.
12. **Contact** — email for privacy queries.

---

## 4. Terms of Use — required sections

1. **Acceptance** — using the site = accepting the terms.
2. **Eligibility** — minimum age (13+ or 16+ depending on jurisdiction).
3. **Account / API key**
   - Keys are issued at the operator's discretion (invite-only).
   - User is responsible for keeping their key confidential.
   - The operator may revoke keys at any time, with or without notice, for
     abuse, illegal use, or any reason.
4. **Acceptable use**
   - No uploading malware, illegal content, or files that don't belong to
     the user / aren't theirs to share.
   - No reverse-engineering rate limits, no scraping, no DDoS.
   - No using the service to violate Vintage Story's EULA or any third
     party's IP.
5. **Rate limits** — state the default (5 req/hour) and that limits may
   change without notice.
6. **User-contributed content (Contribute workflow)** — *this is the most
   important section* because the contributed `.db` files become part of a
   shared dataset:
   - User warrants they have the right to upload the map data.
   - User grants the operator a **perpetual, irrevocable, worldwide,
     royalty-free licence** to host, display, modify, merge, and
     redistribute the contributed data as part of the community map.
   - Contributions may be **merged irreversibly** and cannot be withdrawn
     once approved (link back to Privacy Policy §8 caveat).
   - Operator may reject/delete pending contributions at any time.
7. **Intellectual property**
   - The site's code is licensed under **GNU GPL v2** (already in the
     repo's LICENSE file) — link to it.
   - "Vintage Story" is a trademark of Anego Studios; this project is an
     unaffiliated fan tool.
   - The community map dataset's licence — **decide and state explicitly**
     (recommended: CC BY-SA 4.0 or CC0 so contributors and consumers are
     clear).
8. **Disclaimer of warranties** — service provided "AS IS", no guarantee of
   uptime, no guarantee that uploads / merges won't be lost or corrupted;
   users should keep backups of their save files.
9. **Limitation of liability** — operator not liable for save-file
   corruption, lost waypoints, etc. Users must back up before using
   import/delete/merge tools.
10. **Indemnification** — user indemnifies operator for content they upload.
11. **Termination** — operator may terminate access at any time.
12. **Governing law / jurisdiction** — pick one (your country of residence
    is fine for a hobby project).
13. **Changes to terms** — versioning + how users are notified.
14. **Contact** — same email as privacy.

---

## 5. UI / implementation tasks

These are the concrete code/content changes still to do after these docs
are drafted:

- [x] **Cookie / storage consent banner** — implemented in
  [frontend/src/components/CookieConsent.tsx](frontend/src/components/CookieConsent.tsx).
  Blocks the invite-claim flow until the user clicks Accept.
- [ ] Add `/terms` and `/privacy` routes + pages to the frontend, rendering
  the finalised legal text (Markdown → React component is fine).
- [ ] Footer links to `/terms` and `/privacy` on every page.
- [ ] In the **Contribute** page: an explicit "I understand my contribution
  will be merged irrevocably and cannot be withdrawn" checkbox required
  before upload.
- [ ] In the invite-claim dialog: a line "By claiming this key you agree
  to the Terms of Use and Privacy Policy" with links.
- [ ] Add an admin contact email to the site footer / general page.
- [ ] Add a `last updated` date to both docs and bump it whenever they
  change.
- [ ] Decide and document the **community-map data licence** (recommended
  CC BY-SA 4.0).
- [ ] Tighten backend logging so API keys never appear in production logs
  (avoid logging full `X-API-Key` header values).

---

## 6. Suggested order of work

1. Pick jurisdiction + community-map licence (decisions only).
2. Generate first drafts via Termly/iubenda using §2 and §3/§4 as input.
3. Have the drafts reviewed (lawyer if budget allows; otherwise community
   review).
4. Add `/terms`, `/privacy` pages + footer links.
5. Add the "irrevocable contribution" acknowledgement checkbox on the
   Contribute page.
6. Done.
