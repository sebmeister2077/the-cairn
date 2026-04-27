import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function GeneralPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cairn</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-muted-foreground">
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <strong>Unofficial fan project.</strong> This site is not affiliated with, endorsed by, or
          sponsored by Anego Studios, the developers of <em>Vintage Story</em>. “Vintage Story” is a
          trademark of Anego Studios.
        </div>
        <p className="rounded border border-border bg-muted/40 p-3 italic">
          <strong className="not-italic text-foreground">
            <a
              href="https://en.wikipedia.org/wiki/Cairn"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-primary"
            >
              cairn
            </a>
          </strong>{" "}
          <span className="not-italic">(noun)</span>: what your ancestors built when they ran out of
          dye and signs but still needed to mark the spot where they died to a drifter. We&rsquo;ve
          upgraded the tech a little.
        </p>
        <p>
          A web toolkit for managing Vintage Story waypoints and map data. Choose a category above
          to get started.
        </p>
        <div className="grid gap-3">
          <div>
            <p className="font-medium text-foreground">Singleplayer</p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>
                <strong>Extract</strong> &mdash; pull waypoints out of your{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.vcdbs</code> save
                file into JSON.
              </li>
              <li>
                <strong>Import</strong> &mdash; write waypoints back into a save file (append or
                replace).
              </li>
              <li>
                <strong>Commands</strong> &mdash; generate{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">
                  /waypoint addati
                </code>{" "}
                chat commands from a JSON list.
              </li>
              <li>
                <strong>Delete</strong> &mdash; remove matching waypoints from a save file by name,
                icon, or colour.
              </li>
            </ul>
            <p className="text-xs italic mt-2">
              Singleplayer tools only touch the waypoints table of the
              <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono mx-1">.vcdbs</code>
              file you upload &mdash; nothing else is read or modified, and the uploaded file is
              held in memory only for the duration of the request, then discarded. Your world data
              never leaves your machine permanently.
            </p>
          </div>
          <div>
            <p className="font-medium text-foreground">Multiplayer</p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>
                <strong>Identify Maps</strong> &mdash; figure out which{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.db</code> map
                cache files belong to which server using your client log.
              </li>
              <li>
                <strong>Local Map Viewer</strong> &mdash; render and explore a cached map{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.db</code> file as
                an interactive image.
              </li>
              <li>
                <strong>TOPS Map Viewer</strong> &mdash; explore the community-contributed global
                server map.
              </li>
              <li>
                <strong>Contribute</strong> &mdash; upload your map cache to help build a shared
                community map for your server.
              </li>
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
