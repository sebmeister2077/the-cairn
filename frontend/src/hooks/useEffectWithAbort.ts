import { useEffect } from "react";



export function useEffectWithAbort(effect: (opts: {
    signal: AbortSignal;
    ifNotAbortedThen: <T>(callback: (value: T) => void) => (res: T) => void;
}) => void | (() => void), deps: any[]) {

    return useEffect(() => {
        const abortController = new AbortController();

        function ifNotAbortedThen<T>(callback: (value: T) => void): (res: T) => void {
            return (res: T) => {
                if (!abortController.signal.aborted) {
                    callback(res);
                }
            };
        }

        const cleanupFunc = effect({ signal: abortController.signal, ifNotAbortedThen });
        return () => {
            abortController.abort();
            if (cleanupFunc) {
                cleanupFunc();
            }
        };
    }, deps ?? []);
}
