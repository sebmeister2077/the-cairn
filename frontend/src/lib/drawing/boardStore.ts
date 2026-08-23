// IndexedDB persistence for planning boards + blueprints.
//
// Boards can grow large (free-hand strokes are point-heavy), so they live in
// IndexedDB rather than the ~5MB localStorage envelope that backs the rest of
// the Redux store. A tiny promise wrapper keeps us dependency-free.

import {
    type Blueprint,
    type Board,
    type BoardIndexEntry,
    type BlueprintIndexEntry,
    boardIndexEntry,
    blueprintIndexEntry,
} from "./types";

const DB_NAME = "vsw-drawing";
const DB_VERSION = 1;
const BOARDS_STORE = "boards";
const BLUEPRINTS_STORE = "blueprints";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        if (typeof indexedDB === "undefined") {
            resolve(null);
            return;
        }
        let req: IDBOpenDBRequest;
        try {
            req = indexedDB.open(DB_NAME, DB_VERSION);
        } catch {
            resolve(null);
            return;
        }
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(BOARDS_STORE)) {
                db.createObjectStore(BOARDS_STORE, { keyPath: "id" });
            }
            if (!db.objectStoreNames.contains(BLUEPRINTS_STORE)) {
                db.createObjectStore(BLUEPRINTS_STORE, { keyPath: "id" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });
    return dbPromise;
}

function tx<T>(
    storeName: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
    return openDb().then(
        (db) =>
            new Promise((resolve) => {
                if (!db) {
                    resolve(null);
                    return;
                }
                let request: IDBRequest<T>;
                try {
                    const transaction = db.transaction(storeName, mode);
                    request = run(transaction.objectStore(storeName));
                } catch {
                    resolve(null);
                    return;
                }
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(null);
            }),
    );
}

function getAll<T>(storeName: string): Promise<T[]> {
    return tx<T[]>(storeName, "readonly", (s) => s.getAll() as IDBRequest<T[]>).then(
        (r) => r ?? [],
    );
}

// ── Boards ────────────────────────────────────────────────────────────────

export async function putBoard(board: Board): Promise<void> {
    await tx(BOARDS_STORE, "readwrite", (s) => s.put(board) as IDBRequest<IDBValidKey>);
}

export async function getBoard(id: string): Promise<Board | null> {
    return (await tx<Board>(BOARDS_STORE, "readonly", (s) => s.get(id) as IDBRequest<Board>)) ?? null;
}

export async function deleteBoard(id: string): Promise<void> {
    await tx(BOARDS_STORE, "readwrite", (s) => s.delete(id) as unknown as IDBRequest<undefined>);
}

export async function listBoardIndex(): Promise<BoardIndexEntry[]> {
    const boards = await getAll<Board>(BOARDS_STORE);
    return boards
        .map(boardIndexEntry)
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Blueprints ──────────────────────────────────────────────────────────────

export async function putBlueprint(bp: Blueprint): Promise<void> {
    await tx(BLUEPRINTS_STORE, "readwrite", (s) => s.put(bp) as IDBRequest<IDBValidKey>);
}

export async function getBlueprint(id: string): Promise<Blueprint | null> {
    return (
        (await tx<Blueprint>(BLUEPRINTS_STORE, "readonly", (s) => s.get(id) as IDBRequest<Blueprint>)) ??
        null
    );
}

export async function deleteBlueprint(id: string): Promise<void> {
    await tx(BLUEPRINTS_STORE, "readwrite", (s) => s.delete(id) as unknown as IDBRequest<undefined>);
}

export async function listBlueprintIndex(): Promise<BlueprintIndexEntry[]> {
    const bps = await getAll<Blueprint>(BLUEPRINTS_STORE);
    return bps.map(blueprintIndexEntry).sort((a, b) => b.createdAt - a.createdAt);
}
