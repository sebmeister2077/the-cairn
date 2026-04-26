/**
 * Visible safety/privacy notice shown at the top of every singleplayer tool.
 *
 * Two flavours:
 *   - "read"   — the tool only reads the uploaded save file (Extract, Commands).
 *                Shows the privacy line only.
 *   - "modify" — the tool returns a modified copy of the save (Import, Delete).
 *                Shows the privacy line AND a prominent "back up first" warning.
 */

type Mode = "read" | "modify";

interface SafetyNoticeProps {
  mode: Mode;
}

export function SafetyNotice({ mode }: SafetyNoticeProps) {
  return (
    <div className="space-y-2">
      {mode === "modify" && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-xs text-red-900">
          <strong>Back up your save file first.</strong> This tool returns a
          modified copy of your <code>.vcdbs</code>. If you replace your
          original with the result and something is wrong, the original is
          gone. Keep a copy of the file you upload.
        </div>
      )}
      <div className="rounded border border-sky-300 bg-sky-50 p-3 text-xs text-sky-900">
        <strong>Your save file is not stored.</strong> The file you upload is
        held in memory only for the duration of this request, used to{" "}
        {mode === "modify" ? "modify the waypoints table" : "read the waypoints table"}
        , and then discarded. Nothing about your world (terrain, players,
        inventory, chunks) is read, copied, or kept on the server.
      </div>
    </div>
  );
}
