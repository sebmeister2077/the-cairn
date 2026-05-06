import { createQueryKeys } from '@lukemorales/query-key-factory'
import { API_BASE, authHeaders, getContributeInfo, getLandmarksUrl, handleResponse, listMyLandmarkEditRequests, type LandmarkFeature } from '../api'
import type { QueryFunctionContext } from '@tanstack/react-query';



export const contributeQueries = createQueryKeys('contribute', {
    contributeInfo: ({
        queryKey: null,
        queryFn: ({ signal }) => getContributeInfo(signal)
    })
});



export const landmarkQueries = createQueryKeys('landmarks', {
    geojsonFeatures: {
        queryKey: null,
        queryFn: async (): Promise<LandmarkFeature[]> => {
            const { url } = await getLandmarksUrl();
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Failed to load landmarks (${res.status})`);
            const data = await res.json();
            const feats = Array.isArray(data?.features) ? data.features : [];
            return feats as LandmarkFeature[];
        }
    },
    editRequest: {
        queryKey: null,
        queryFn: () => listMyLandmarkEditRequests(50)
    },
})
