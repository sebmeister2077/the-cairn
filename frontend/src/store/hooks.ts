import { useDispatch, useSelector } from "react-redux";
import type { TypedUseSelectorHook } from "react-redux";
import type { AppDispatch, RootState } from "./index";

/** Typed `useDispatch` — call with no args, returns the configured AppDispatch. */
export const useAppDispatch: () => AppDispatch = useDispatch;

/** Typed `useSelector` — narrows to the app's RootState. */
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
