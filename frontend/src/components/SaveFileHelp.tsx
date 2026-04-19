import { HelpCircle } from "lucide-react";

export function SaveFileHelp() {
  return (
    <details className="group rounded-md border text-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-muted-foreground hover:text-foreground select-none [&::-webkit-details-marker]:hidden list-none">
        <HelpCircle className="h-4 w-4 shrink-0" />
        <span>Where can I find my save file?</span>
        <svg className="ml-auto h-4 w-4 shrink-0 transition-transform group-open:rotate-180" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div className="border-t px-3 py-3 space-y-3 text-muted-foreground">
        <p>
          Vintage Story stores your world saves as <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.vcdbs</code> files
          in the <strong>Saves</strong> folder. Each world has its own subfolder.
        </p>
        <div className="space-y-2">
          <div>
            <p className="font-medium text-foreground">Windows</p>
            <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono break-all">
              %appdata%\VintagestoryData\Saves\
            </code>
          </div>
          <div>
            <p className="font-medium text-foreground">Linux</p>
            <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono break-all">
              ~/.config/VintagestoryData/Saves/
            </code>
          </div>
          <div>
            <p className="font-medium text-foreground">macOS</p>
            <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono break-all">
              ~/Library/Application Support/VintagestoryData/Saves/
            </code>
          </div>
        </div>
        <p className="text-xs">
          Inside your world folder, look for the <code className="rounded bg-muted px-1 py-0.5 font-mono">.vcdbs</code> file
          (e.g. <code className="rounded bg-muted px-1 py-0.5 font-mono">game.vcdbs</code>). This is the file to upload.
        </p>
      </div>
    </details>
  );
}
