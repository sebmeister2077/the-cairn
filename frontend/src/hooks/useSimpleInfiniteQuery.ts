import { useInfiniteQuery, type DefaultError, type QueryKey } from "@tanstack/react-query";


export type Page<T> = { items: T[]; total: number; next_offset: number | null };

export function useSimpleInfiniteQuery<T, TQueryKey extends QueryKey = readonly unknown[]>(props: Parameters<typeof useInfiniteQuery<Page<T>, DefaultError, Page<T>, TQueryKey, number>>[0]):
    ReturnType<typeof useInfiniteQuery<Page<T>, DefaultError, Page<T>, TQueryKey, number>> {

    return useInfiniteQuery(props);
}