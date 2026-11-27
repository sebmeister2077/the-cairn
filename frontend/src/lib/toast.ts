import { Toast as ToastPrimitive } from "@base-ui/react/toast";

type ToastType = "success" | "error" | "info";

/** Shared manager consumed by `<Toaster />` (components/ui/toast.tsx). */
export const toastManager = ToastPrimitive.createToastManager();

function show(type: ToastType, title: string, description?: string) {
  return toastManager.add({ type, title, description });
}

/** Imperative toast API usable from anywhere (event handlers, non-React code).
 *  Requires a single `<Toaster />` mounted near the app root. */
export const toast = {
  success: (title: string, description?: string) => show("success", title, description),
  error: (title: string, description?: string) => show("error", title, description),
  info: (title: string, description?: string) => show("info", title, description),
};
