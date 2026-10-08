// Boat-friendly translocators — data hook.
//
// `useBoatFriendlyTLs` loads the admin-curated list (public endpoint) and
// exposes it as a canonical-id Set for O(1) membership tests in the map
// overlay + routing. `useToggleBoatFriendlyTL` is the admin mutation that
// flips one TL's state and updates the cache in place.

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getBoatFriendlyTLs, toggleBoatFriendlyTL, type BoatFriendlyTLsResponse } from "@/lib/api";

export const BOAT_FRIENDLY_TLS_QUERY_KEY = ["boat-friendly-tls"] as const;

export function useBoatFriendlyTLs() {
    const query = useQuery({
        queryKey: [...BOAT_FRIENDLY_TLS_QUERY_KEY],
        queryFn: async () => (await getBoatFriendlyTLs()).tl_ids,
        staleTime: 5 * 60_000,
    });

    const idSet = useMemo(() => new Set(query.data ?? []), [query.data]);

    return { ...query, idSet };
}

export function useToggleBoatFriendlyTL() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (vars: { tlId: string; enabled: boolean }) =>
            toggleBoatFriendlyTL(vars.tlId, vars.enabled),
        onSuccess: (data: BoatFriendlyTLsResponse) => {
            queryClient.setQueryData([...BOAT_FRIENDLY_TLS_QUERY_KEY], data.tl_ids);
        },
    });
}
