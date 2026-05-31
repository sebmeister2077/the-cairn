// Share-link encoder/decoder for the route planner.
//
// Serialises the planner's *inputs* (endpoints, settings, mode,
// rendezvous party, objective) into compact URL query params. The
// recipient's planner rehydrates the inputs and the existing
// `useTLRoute` / `useTLRendezvous` hooks recompute deterministically
// from the live TL database — so we never have to encode the route
// itself.
//
// Wire format (all keys are short to keep the URL pasteable):
//   rp=1                presence flag — required for hydration to fire
//   m=rv                mode: omitted = "route", "rv" = "rendezvous"
//   from=x,z            integer coords, comma-separated
//   to=x,z
//   fl=label            URL-encoded From label (omitted when redundant)
//   tl=label            URL-encoded To label
//   ws, tlp, kn         settings — omitted when equal to slice defaults
//   pl=x,z|x,z|...      rendezvous party, "_" = empty slot
//   pll=l|l|...         per-player labels (same length / order as `pl`)
//   obj=minisum         rendezvous objective — omitted when default "minimax"

import {
    DEFAULT_K_NEIGHBORS,
    DEFAULT_TL_PENALTY_S,
    DEFAULT_WALK_SPEED,
    type RendezvousObjective,
} from "@/lib/tl-routing";
import type { EndpointPick, RoutePlannerMode } from "@/store/slices/routePlanner";

/** Keys the encoder owns. Used to strip the share params from the URL
 *  once the planner has consumed them. */
export const ROUTE_SHARE_PARAM_KEYS = [
    "rp",
    "m",
    "from",
    "to",
    "fl",
    "tl",
    "ws",
    "tlp",
    "kn",
    "pl",
    "pll",
    "obj",
] as const;

/** Payload produced by `decodeRouteShareParams`. All fields optional so
 *  the reducer can apply only what was present. */
export interface RouteSharePayload {
    mode: RoutePlannerMode;
    from: EndpointPick | null;
    to: EndpointPick | null;
    walkSpeed?: number;
    tlPenaltySeconds?: number;
    kNeighbors?: number;
    players?: Array<EndpointPick | null>;
    rendezvousObjective?: RendezvousObjective;
}

/** Inputs needed to build a share link. Mirrors the slice's public surface. */
export interface RouteShareInputs {
    mode: RoutePlannerMode;
    from: EndpointPick | null;
    to: EndpointPick | null;
    walkSpeed: number;
    tlPenaltySeconds: number;
    kNeighbors: number;
    players: Array<EndpointPick | null>;
    rendezvousObjective: RendezvousObjective;
}

function encodePoint(p: EndpointPick): string {
    return `${Math.trunc(p.point.x)},${Math.trunc(p.point.z)}`;
}

/** A label is worth including only when it adds info beyond the coords —
 *  e.g. "Trader camp" — otherwise we save bytes by dropping it. */
function labelIfMeaningful(p: EndpointPick): string | null {
    if (!p.label) return null;
    const trimmed = p.label.trim();
    if (!trimmed) return null;
    const coordy = `${Math.trunc(p.point.x)}, ${Math.trunc(p.point.z)}`;
    if (trimmed === coordy) return null;
    return trimmed;
}

function parsePoint(raw: string): { x: number; z: number } | null {
    const parts = raw.split(",");
    if (parts.length !== 2) return null;
    const x = Number(parts[0]);
    const z = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    return { x: Math.trunc(x), z: Math.trunc(z) };
}

function parseNumberInRange(raw: string | null, min: number, max: number): number | undefined {
    if (raw == null) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    if (n < min || n > max) return undefined;
    return n;
}

/** Build the URLSearchParams for a share link. Returns `null` if the
 *  state has nothing meaningful to share (no endpoints / no players). */
export function encodeRouteShareParams(input: RouteShareInputs): URLSearchParams | null {
    const params = new URLSearchParams();
    params.set("rp", "1");

    if (input.mode === "rendezvous") {
        params.set("m", "rv");
    }

    if (input.mode === "route") {
        if (!input.from && !input.to) return null;
        if (input.from) {
            params.set("from", encodePoint(input.from));
            const lbl = labelIfMeaningful(input.from);
            if (lbl) params.set("fl", lbl);
        }
        if (input.to) {
            params.set("to", encodePoint(input.to));
            const lbl = labelIfMeaningful(input.to);
            if (lbl) params.set("tl", lbl);
        }
    } else {
        const filled = input.players.filter((p) => p != null);
        if (filled.length < 1) return null;
        const slots = input.players.map((p) => (p ? encodePoint(p) : "_"));
        params.set("pl", slots.join("|"));
        const labels = input.players.map((p) => (p ? (labelIfMeaningful(p) ?? "") : ""));
        if (labels.some((l) => l !== "")) {
            params.set("pll", labels.map((l) => encodeURIComponent(l)).join("|"));
        }
        if (input.rendezvousObjective !== "minimax") {
            params.set("obj", input.rendezvousObjective);
        }
    }

    if (input.walkSpeed !== DEFAULT_WALK_SPEED) {
        params.set("ws", String(input.walkSpeed));
    }
    if (input.tlPenaltySeconds !== DEFAULT_TL_PENALTY_S) {
        params.set("tlp", String(input.tlPenaltySeconds));
    }
    if (input.kNeighbors !== DEFAULT_K_NEIGHBORS) {
        params.set("kn", String(input.kNeighbors));
    }

    return params;
}

/** Parse share params off a URL. Returns `null` if the `rp=1` flag is
 *  absent (so non-share URLs are a no-op) or if no usable inputs were
 *  present after parsing. */
export function decodeRouteShareParams(params: URLSearchParams): RouteSharePayload | null {
    if (params.get("rp") !== "1") return null;

    const modeRaw = params.get("m");
    const mode: RoutePlannerMode = modeRaw === "rv" ? "rendezvous" : "route";

    const payload: RouteSharePayload = { mode, from: null, to: null };

    if (mode === "route") {
        const fromRaw = params.get("from");
        const toRaw = params.get("to");
        const fromPt = fromRaw ? parsePoint(fromRaw) : null;
        const toPt = toRaw ? parsePoint(toRaw) : null;
        if (!fromPt && !toPt) return null;
        if (fromPt) {
            const lbl = params.get("fl")?.trim();
            payload.from = {
                point: fromPt,
                label: lbl || undefined,
                source: "url",
            };
        }
        if (toPt) {
            const lbl = params.get("tl")?.trim();
            payload.to = {
                point: toPt,
                label: lbl || undefined,
                source: "url",
            };
        }
    } else {
        const plRaw = params.get("pl");
        if (!plRaw) return null;
        const slots = plRaw.split("|");
        const labelSlots = (params.get("pll") ?? "").split("|");
        const players: Array<EndpointPick | null> = slots.map((slot, i) => {
            if (slot === "_" || slot === "") return null;
            const pt = parsePoint(slot);
            if (!pt) return null;
            const rawLabel = labelSlots[i] ? decodeURIComponent(labelSlots[i]).trim() : "";
            return {
                point: pt,
                label: rawLabel || undefined,
                source: "url",
            };
        });
        // Always keep at least two slots — the rendezvous slice expects it.
        while (players.length < 2) players.push(null);
        if (players.filter((p) => p != null).length < 1) return null;
        payload.players = players;
        const objRaw = params.get("obj");
        if (objRaw === "minimax" || objRaw === "minisum") {
            payload.rendezvousObjective = objRaw;
        }
    }

    const ws = parseNumberInRange(params.get("ws"), 0.5, 20);
    if (ws !== undefined) payload.walkSpeed = ws;
    const tlp = parseNumberInRange(params.get("tlp"), 0, 600);
    if (tlp !== undefined) payload.tlPenaltySeconds = tlp;
    const kn = parseNumberInRange(params.get("kn"), 1, 64);
    if (kn !== undefined) payload.kNeighbors = Math.trunc(kn);

    return payload;
}

/** Build the full shareable URL from the current planner inputs. Returns
 *  `null` if there's nothing worth sharing (matches `encodeRouteShareParams`). */
export function buildRouteShareUrl(input: RouteShareInputs): string | null {
    if (typeof window === "undefined") return null;
    const params = encodeRouteShareParams(input);
    if (!params) return null;
    const { origin, pathname } = window.location;
    return `${origin}${pathname}?${params.toString()}`;
}
