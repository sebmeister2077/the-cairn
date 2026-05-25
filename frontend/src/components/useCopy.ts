import { useState } from "react";

/**
 * Tracks which labelled item was most recently copied to the clipboard.
 *
 * @param timeout Milliseconds after which the `copied` flag auto-clears.
 *   Pass `null` (or any non-positive number) to keep the flag set until
 *   the component unmounts or another copy happens — useful when the user
 *   is expected to leave the page (e.g. paste into another app) and may
 *   forget which item they copied if the indicator disappears.
 */
export function useCopy(timeout: number | null = 1500) {
    const [copied, setCopied] = useState<string | null>(null);
    function copy(text: string, label: string) {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(label);
            if (timeout !== null && timeout > 0) {
                setTimeout(() => setCopied(null), timeout);
            }
        });
    }
    return { copied, copy };
}
