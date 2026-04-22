import { useState } from "react";

export function useCopy(timeout = 1500) {
    const [copied, setCopied] = useState<string | null>(null);
    function copy(text: string, label: string) {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(label);
            setTimeout(() => setCopied(null), timeout);
        });
    }
    return { copied, copy };
}
