import type { RouteOverlay, WorldLineSegment } from "@/components/MapViewer";
import { walkLegEdgeRef, classifyWalkLeg } from "@/lib/elk-walkable";
import type { ElkWalkableEdge } from "@/lib/elk-walkable";
import type { RendezvousResult, RouteResult } from "@/lib/tl-routing";

interface EndpointLike {
    point: { x: number; z: number };
}

export interface BuildRouteOverlayArgs {
    routes: RouteResult[];
    routeSelectedIndex: number;
    routeFrom: EndpointLike | null;
    routeTo: EndpointLike | null;
    routePlannerMode: string;
    rendezvousResult: RendezvousResult | null;
    elkEdges: Record<string, ElkWalkableEdge>;
    elkPendingAttestKeys: ReadonlySet<string>;
    elkPendingUnattestKeys: ReadonlySet<string>;
    selfUserId: string | null;
}

/**
 * Build the visual overlay handed to MapViewer for the route planner. Route
 * mode mirrors the selected route's TL + walk legs with From/To pins;
 * rendezvous mode flattens every per-player route and pins the meeting point.
 */
export function buildRouteOverlay({
    routes,
    routeSelectedIndex,
    routeFrom,
    routeTo,
    routePlannerMode,
    rendezvousResult,
    elkEdges,
    elkPendingAttestKeys,
    elkPendingUnattestKeys,
    selfUserId,
}: BuildRouteOverlayArgs): RouteOverlay | null {
    if (routePlannerMode === "rendezvous") {
        if (!rendezvousResult) return null;
        const tlSegments: WorldLineSegment[] = [];
        const walkLegs: RouteOverlay["walkLegs"] = [];
        for (const perPlayer of rendezvousResult.perPlayer) {
            const legs = perPlayer.route.legs;
            for (let i = 0; i < legs.length; i++) {
                const leg = legs[i];
                if (leg.kind === "tl") {
                    tlSegments.push(leg.segment);
                } else {
                    const ref = walkLegEdgeRef(legs, i);
                    const elkState = classifyWalkLeg(
                        ref,
                        elkEdges,
                        elkPendingAttestKeys,
                        elkPendingUnattestKeys,
                        selfUserId,
                    );
                    walkLegs.push({ from: leg.from, to: leg.to, elkState });
                }
            }
        }
        return {
            tlSegments,
            walkLegs,
            from: null,
            to: { x: rendezvousResult.meeting.x, z: rendezvousResult.meeting.z },
        };
    }
    const selected = routes[routeSelectedIndex] ?? routes[0] ?? null;
    if (!selected && !routeFrom && !routeTo) return null;
    const tlSegments: WorldLineSegment[] = [];
    const walkLegs: RouteOverlay["walkLegs"] = [];
    if (selected) {
        const legs = selected.legs;
        for (let i = 0; i < legs.length; i++) {
            const leg = legs[i];
            if (leg.kind === "tl") {
                tlSegments.push(leg.segment);
            } else {
                const ref = walkLegEdgeRef(legs, i);
                const elkState = classifyWalkLeg(
                    ref,
                    elkEdges,
                    elkPendingAttestKeys,
                    elkPendingUnattestKeys,
                    selfUserId,
                );
                walkLegs.push({ from: leg.from, to: leg.to, elkState });
            }
        }
    }
    return {
        tlSegments,
        walkLegs,
        from: routeFrom?.point ?? null,
        to: routeTo?.point ?? null,
    };
}
