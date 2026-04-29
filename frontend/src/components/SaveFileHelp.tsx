import { FilePathHelp } from "@/components/FilePathHelp";

const SAVE_PATHS = [
  { label: "Windows", path: "%appdata%\\VintagestoryData\\Saves\\" },
  { label: "Linux", path: "~/.config/VintagestoryData/Saves/" },
  { label: "macOS", path: "~/Library/Application Support/VintagestoryData/Saves/" },
];

export function SaveFileHelp() {
  return (
    <FilePathHelp
      summary="Where can I find my save file?"
      intro={
        <p>
          Vintage Story stores your world saves as{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.vcdbs</code> files in
          the <strong>Saves</strong> folder. Each world has its own subfolder.
        </p>
      }
      items={SAVE_PATHS}
      footer={
        <p className="text-xs">
          Inside your world folder, look for the{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">.vcdbs</code> file (e.g.{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">game.vcdbs</code>). This is the
          file to upload.
        </p>
      }
    />
  );
}
