import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { CheckCircle2, X, XCircle } from "lucide-react";

import { cn } from "@/lib/helpers/utils";
import { toastManager } from "@/lib/toast";

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((t) => (
    <ToastPrimitive.Root
      key={t.id}
      toast={t}
      data-slot="toast"
      className={cn(
        "pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] items-start gap-2 rounded-md border bg-popover p-3 text-popover-foreground shadow-lg transition-all duration-200",
        "data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:translate-y-2 data-ending-style:opacity-0",
      )}
    >
      {t.type === "success" && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />}
      {t.type === "error" && <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />}
      <ToastPrimitive.Content className="min-w-0 flex-1">
        <ToastPrimitive.Title className="text-sm font-medium" />
        <ToastPrimitive.Description className="mt-0.5 wrap-break-word font-mono text-xs text-muted-foreground" />
      </ToastPrimitive.Content>
      <ToastPrimitive.Close
        aria-label="Close"
        className="shrink-0 rounded-sm opacity-60 transition-opacity hover:opacity-100"
      >
        <X className="h-4 w-4" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  ));
}

export function Toaster({ timeout = 4000 }: { timeout?: number }) {
  return (
    <ToastPrimitive.Provider toastManager={toastManager} timeout={timeout}>
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport className="pointer-events-none fixed right-4 bottom-4 z-100 flex flex-col-reverse gap-2 outline-none">
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}
