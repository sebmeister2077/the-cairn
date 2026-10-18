/**
 * Browser-compatible functions for correlating Vintage Story multiplayer
 * server connections with map database files.
 *
 * Ported from identify_maps.ts (root) — only the browser-safe core.
 */

export interface MapFileInfo {
    name: string;
    lastModified: number;
    size: number;
}

export interface ServerConnection {
    serverAddress: string;
    connectedAt: Date;
}

export interface ServerMapResult {
    serverAddress: string;
    friendlyName: string | null;
    dbFile: string | null;
    dbSizeMB: number | null;
    lastConnected: Date;
}

export function parseConnections(logContents: string | string[]): ServerConnection[] {
    const logs = Array.isArray(logContents) ? logContents : [logContents];
    const connections: ServerConnection[] = [];

    const timestampRegex = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/;
    const connectRegex = /\[Notification\]\s+Connecting to (.+?)\.\.\./;
    const finalizeRegex = /\[Notification\]\s+Received level finalize/;

    for (const logContent of logs) {
        let lastServerAddress: string | null = null;

        for (const line of logContent.split(/\r?\n/)) {
            const connectMatch = line.match(connectRegex);
            if (connectMatch) {
                lastServerAddress = connectMatch[1];
                continue;
            }

            if (finalizeRegex.test(line) && lastServerAddress) {
                const tsMatch = line.match(timestampRegex);
                if (tsMatch) {
                    const [, day, month, year, hour, min, sec] = tsMatch;
                    connections.push({
                        serverAddress: lastServerAddress,
                        connectedAt: new Date(
                            parseInt(year), parseInt(month) - 1, parseInt(day),
                            parseInt(hour), parseInt(min), parseInt(sec),
                        ),
                    });
                }
                lastServerAddress = null;
            }
        }
    }

    return connections;
}

export function parseServerNames(clientSettingsContent: string): Record<string, string> {
    const nameMap: Record<string, string> = {};
    try {
        const settings = JSON.parse(clientSettingsContent);
        const servers: string[] = settings?.stringListSettings?.multiplayerservers ?? [];
        for (const entry of servers) {
            const parts = entry.split(",");
            if (parts.length >= 2) {
                const friendlyName = parts[0].trim();
                const address = parts[1].trim();
                nameMap[address] = friendlyName;
                const hostOnly = address.split(":")[0];
                if (!nameMap[hostOnly]) nameMap[hostOnly] = friendlyName;
            }
        }
    } catch { /* ignore parse errors */ }
    return nameMap;
}

export function extractDBFromLogs(
    logContents: string | string[],
    mapFiles?: MapFileInfo[],
    clientSettings?: string,
): ServerMapResult[] {
    const connections = parseConnections(logContents);
    if (connections.length === 0) return [];

    const serverNames = clientSettings ? parseServerNames(clientSettings) : {};

    const latestByServer = new Map<string, ServerConnection>();
    for (const conn of connections) {
        const existing = latestByServer.get(conn.serverAddress);
        if (!existing || conn.connectedAt > existing.connectedAt) {
            latestByServer.set(conn.serverAddress, conn);
        }
    }

    if (!mapFiles || mapFiles.length === 0) {
        return [...latestByServer.values()]
            .sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime())
            .map(conn => ({
                serverAddress: conn.serverAddress,
                friendlyName: serverNames[conn.serverAddress]
                    || serverNames[conn.serverAddress.split(":")[0]]
                    || null,
                dbFile: null,
                dbSizeMB: null,
                lastConnected: conn.connectedAt,
            }));
    }

    const dbFiles = mapFiles
        .filter(f => f.name.endsWith(".db"))
        .map(f => ({ ...f }));

    const sortedConnections = [...latestByServer.values()]
        .sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime());

    const results: ServerMapResult[] = [];
    const assignedDbs = new Set<string>();

    for (const conn of sortedConnections) {
        let bestFile: MapFileInfo | null = null;
        let bestDiff = Infinity;

        for (const db of dbFiles) {
            if (assignedDbs.has(db.name)) continue;
            const diff = db.lastModified - conn.connectedAt.getTime();
            if (diff >= 0 && diff < 24 * 60 * 60 * 1000 && diff < bestDiff) {
                bestDiff = diff;
                bestFile = db;
            }
        }

        const friendlyName = serverNames[conn.serverAddress]
            || serverNames[conn.serverAddress.split(":")[0]]
            || null;

        results.push({
            serverAddress: conn.serverAddress,
            friendlyName,
            dbFile: bestFile?.name ?? null,
            dbSizeMB: bestFile ? Math.round(bestFile.size / (1024 * 1024) * 10) / 10 : null,
            lastConnected: conn.connectedAt,
        });

        if (bestFile) assignedDbs.add(bestFile.name);
    }

    return results;
}
