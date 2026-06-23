import type { LibraryInstallResult } from "@/lib/api";

export function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-center py-10">{children}</div>;
}

export function EmptyState({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
      {icon}
      {text}
    </div>
  );
}

/** Map an install API result into the local-store payload shape. */
export function toInstallPayload(result: LibraryInstallResult) {
  return {
    libraryId: result.grouping.libraryId,
    name: result.grouping.name,
    color: result.grouping.color,
    tlIds: result.grouping.tlIds,
    author: result.grouping.author,
    version: result.grouping.version,
    mode: result.mode,
  };
}
