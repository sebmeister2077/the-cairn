import { useDispatch, useSelector } from "react-redux";
import type { TypedUseSelectorHook } from "react-redux";
import type { AppDispatch, RootState } from "./";
import type { Path, PathValue } from "react-hook-form";

/** Typed `useDispatch` — call with no args, returns the configured AppDispatch. */
export const useAppDispatch: () => AppDispatch = useDispatch;

/** Typed `useSelector` — narrows to the app's RootState. */
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

export function useReduxState<P extends Path<RootState>>(path: P): PathValue<RootState, P> {
    return useSelector((state: RootState) => {
        const parts = path.split(".");
        return parts.reduce((prev, current) => (prev as any)[current as any], state) as PathValue<RootState, P>;
    });
}
