// Pure helpers for turning a computed route into paste-ready in-game
// waypoints. Extracted from `RoutePlannerPanel` so the component keeps
// only view logic. No React imports — safe to unit-test in isolation.

import type { RouteResult } from "@/lib/tl-routing";

// Y coordinate used as a fallback when a TL endpoint has no recorded Y
// (user-contributed TLs only carry 2D coordinates). Seeded TLs ship
// `y1`/`y2` and are passed through directly so the in-game waypoint sits
// at the correct depth.
export const FALLBACK_WAYPOINT_Y = 110;

/** Per-waypoint context exposed to label templates. */
export interface WaypointContext {
    i: number;
    n: number;
    x: number;
    y: number;
    z: number;
    /** Coordinates of the OTHER end of the TL this waypoint sits on —
     *  i.e. where stepping into this TL will take the player. Same as
     *  `x`/`z` if this waypoint has no linked endpoint (shouldn't happen
     *  in practice since chain entries are only emitted for TL hops). */
    linked_x: number;
    linked_z: number;
    next_x: number | "";
    next_z: number | "";
    prev_x: number | "";
    prev_z: number | "";
    dest_x: number;
    dest_z: number;
    start_x: number;
    start_z: number;
}

/** Substitute `{placeholder}` tokens in a template, leaving unknown tokens
 *  in place so the user gets a visible hint that they mistyped. */
export function renderTemplate(template: string, ctx: WaypointContext): string {
    return template.replace(/\{(\w+)\}/g, (match, key: string) => {
        if (key in ctx) {
            const v = (ctx as unknown as Record<string, number | string>)[key];
            return String(v);
        }
        return match;
    });
}

/** A single waypoint candidate — a TL endpoint plus the coordinates of
 *  the TL's OTHER end (so label templates can show "goes to (x,z)"). */
export interface RouteWaypoint {
    x: number;
    z: number;
    y: number;
    linked_x: number;
    linked_z: number;
}

/** Collapse a route into the chain of unique waypoints worth dropping in
 *  the world: only TL endpoints (entry + exit of each TL hop). Route
 *  start and finish are intentionally excluded — the player already
 *  knows where they're standing and where they're going; what they need
 *  marked on the map are the translocators they have to find. Consecutive
 *  duplicates are dropped so a TL exit immediately followed by another
 *  TL entry at the same coords only produces one waypoint. When that
 *  collapse happens we overwrite the previous waypoint's linked endpoint
 *  with the NEXT TL's exit so the label reflects where the player will
 *  travel from this point, not where they just came from. */
export function routeWaypointChain(route: RouteResult): RouteWaypoint[] {
    const chain: RouteWaypoint[] = [];
    for (const leg of route.legs) {
        if (leg.kind !== "tl") continue;
        const seg = leg.segment;
        // Map `from`/`to` back to the seg's (x1,y1,z1)/(x2,y2,z2) pair so we
        // can pull the correct Y for each endpoint. User-contributed TLs omit
        // y1/y2 — fall back to a reasonable surface value in that case.
        const fromIs1 = seg.x1 === leg.from.x && seg.z1 === leg.from.z;
        const fromY = (fromIs1 ? seg.y1 : seg.y2) ?? FALLBACK_WAYPOINT_Y;
        const toY = (fromIs1 ? seg.y2 : seg.y1) ?? FALLBACK_WAYPOINT_Y;
        const entry: RouteWaypoint = {
            x: leg.from.x,
            z: leg.from.z,
            y: fromY,
            linked_x: leg.to.x,
            linked_z: leg.to.z,
        };
        const last = chain[chain.length - 1];
        if (!last || last.x !== entry.x || last.z !== entry.z) {
            chain.push(entry);
        } else {
            // Same physical spot — swap the previous TL's outgoing-link for this
            // new TL's so the label tells the player where THIS TL goes next.
            chain[chain.length - 1] = entry;
        }
        const exit: RouteWaypoint = {
            x: leg.to.x,
            z: leg.to.z,
            y: toY,
            linked_x: leg.from.x,
            linked_z: leg.from.z,
        };
        const prev = chain[chain.length - 1];
        if (prev.x !== exit.x || prev.z !== exit.z) {
            chain.push(exit);
        }
    }
    return chain;
}
