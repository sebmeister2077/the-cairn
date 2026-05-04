import { createQueryKeys } from '@lukemorales/query-key-factory'
import { API_BASE, authHeaders, getContributeInfo, handleResponse } from '../api'
import type { QueryFunctionContext } from '@tanstack/react-query';



export const contributeQueries = createQueryKeys('contribute', {
    contributeInfo: ({
        queryKey: null,
        queryFn: ({ signal }) => getContributeInfo(signal)
    })
});


