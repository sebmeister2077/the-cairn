import { useCallback, useState, type ReactNode } from "react";
import { Check, ClipboardCopy, HelpCircle } from "lucide-react";

export interface FilePathHelpItem {
  label: string;
  path: string;
}

interface FilePathHelpProps {
  /** Text shown in the collapsed `<summary>` row. */
  summary: string;
  /** Optional intro paragraph(s) rendered above the path list. */
  intro?: ReactNode;
  /** Path entries to render with copy-to-clipboard buttons. */
  items: FilePathHelpItem[];
  /** Optional footer note rendered below the path list. */
  footer?: ReactNode;
}

/**
 * Collapsible "Where can I find this file?" panel listing one or more
 * platform/role-specific paths with a copy-to-clipboard button per row.
 *
 * Used across the multiplayer pages (Identify Maps, Local Map Viewer,
 * Contribute) so the styling stays consistent.
 */
export function FilePathHelp({ summary, intro, items, footer }: FilePathHelpProps) {
  const [copied, setCopied] = useState<string | null>(null);

  const copyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path).then(() => {
      setCopied(path);
      setTimeout(() => setCopied(null), 1500);
    });
  }, []);

  return (
    <details className="group rounded-md border text-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-muted-foreground hover:text-foreground select-none [&::-webkit-details-marker]:hidden list-none">
        <HelpCircle className="h-4 w-4 shrink-0" />
        <span>{summary}</span>
        <svg
          className="ml-auto h-4 w-4 shrink-0 transition-transform group-open:rotate-180"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>
      <div className="border-t px-3 py-3 space-y-3 text-muted-foreground">
        {intro}
        <div className="grid gap-1.5">
          {items.map(({ label, path }) => (
            <div key={label} className="flex items-center gap-2">
              <span className="font-medium text-foreground w-16 shrink-0">{label}:</span>
              <code className="min-w-0 flex-1 rounded bg-muted px-1.5 py-0.5 text-xs font-mono break-all select-all">
                {path}
              </code>
              <button
                type="button"
                className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer transition-colors shrink-0"
                onClick={() => copyPath(path)}
                title="Copy path"
                aria-label={`Copy ${label} path`}
              >
                {copied === path ? (
                  <Check className="size-3.5" />
                ) : (
                  <ClipboardCopy className="size-3.5" />
                )}
              </button>
            </div>
          ))}
        </div>
        {footer}
      </div>
    </details>
  );
}
