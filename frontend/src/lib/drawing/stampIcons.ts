// Vector stamp icons for planning boards.
//
// Path data is derived from Lucide (https://lucide.dev), ISC-licensed. Baking the
// primitives in-repo lets us render stamps as crisp, tintable, outline-able
// vectors on the canvas — identical on every OS (unlike emoji) and usable both
// on the map (drawStampIcon) and in the picker UI (as inline SVG).

export type IconPrim =
    | { t: "path"; d: string }
    | { t: "circle"; cx: number; cy: number; r: number; fill?: boolean }
    | { t: "line"; x1: number; y1: number; x2: number; y2: number }
    | { t: "polyline"; points: string }
    | { t: "polygon"; points: string };

export interface StampIcon {
    id: string;
    label: string;
    node: IconPrim[];
}

/** All icons are authored on Lucide's 24×24, stroke-width-2, round-cap grid. */
export const STAMP_ICONS: StampIcon[] = [
    {
        id: "house", label: "House", node: [
            { t: "path", d: "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" },
            { t: "path", d: "M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" },
        ]
    },
    {
        id: "castle", label: "Castle", node: [
            { t: "path", d: "M10 5V3" },
            { t: "path", d: "M14 5V3" },
            { t: "path", d: "M15 21v-3a3 3 0 0 0-6 0v3" },
            { t: "path", d: "M18 3v8" },
            { t: "path", d: "M18 5H6" },
            { t: "path", d: "M22 11H2" },
            { t: "path", d: "M22 9v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9" },
            { t: "path", d: "M6 3v8" },
        ]
    },
    {
        id: "tent", label: "Camp", node: [
            { t: "path", d: "M3.5 21 14 3" },
            { t: "path", d: "M20.5 21 10 3" },
            { t: "path", d: "M15.5 21 12 15l-3.5 6" },
            { t: "path", d: "M2 21h20" },
        ]
    },
    {
        id: "warehouse", label: "Storage", node: [
            { t: "path", d: "M18 21V10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v11" },
            { t: "path", d: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 1.132-1.803l7.95-3.974a2 2 0 0 1 1.837 0l7.948 3.974A2 2 0 0 1 22 8z" },
            { t: "path", d: "M6 13h12" },
            { t: "path", d: "M6 17h12" },
        ]
    },
    {
        id: "store", label: "Trader", node: [
            { t: "path", d: "M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5" },
            { t: "path", d: "M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244" },
            { t: "path", d: "M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05" },
        ]
    },
    {
        id: "factory", label: "Factory", node: [
            { t: "path", d: "M12 16h.01" },
            { t: "path", d: "M16 16h.01" },
            { t: "path", d: "M3 19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5a.5.5 0 0 0-.769-.422l-4.462 2.844A.5.5 0 0 1 15 10.5v-2a.5.5 0 0 0-.769-.422L9.77 10.922A.5.5 0 0 1 9 10.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z" },
            { t: "path", d: "M8 16h.01" },
        ]
    },
    {
        id: "pickaxe", label: "Mine", node: [
            { t: "path", d: "m14 13-8.381 8.38a1 1 0 0 1-3.001-3L11 9.999" },
            { t: "path", d: "M15.973 4.027A13 13 0 0 0 5.902 2.373c-1.398.342-1.092 2.158.277 2.601a19.9 19.9 0 0 1 5.822 3.024" },
            { t: "path", d: "M16.001 11.999a19.9 19.9 0 0 1 3.024 5.824c.444 1.369 2.26 1.676 2.603.278A13 13 0 0 0 20 8.069" },
            { t: "path", d: "M18.352 3.352a1.205 1.205 0 0 0-1.704 0l-5.296 5.296a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l5.296-5.296a1.205 1.205 0 0 0 0-1.704z" },
        ]
    },
    {
        id: "gem", label: "Ore / gem", node: [
            { t: "path", d: "M10.5 3 8 9l4 13 4-13-2.5-6" },
            { t: "path", d: "M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3z" },
            { t: "path", d: "M2 9h20" },
        ]
    },
    {
        id: "mountain", label: "Mountain", node: [
            { t: "path", d: "m8 3 4 8 5-5 5 15H2L8 3z" },
        ]
    },
    {
        id: "tree-pine", label: "Forest", node: [
            { t: "path", d: "m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z" },
            { t: "path", d: "M12 22v-3" },
        ]
    },
    {
        id: "wheat", label: "Farm", node: [
            { t: "path", d: "M2 22 16 8" },
            { t: "path", d: "M3.47 12.53 5 11l1.53 1.53a3.5 3.5 0 0 1 0 4.94L5 19l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z" },
            { t: "path", d: "M7.47 8.53 9 7l1.53 1.53a3.5 3.5 0 0 1 0 4.94L9 15l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z" },
            { t: "path", d: "M11.47 4.53 13 3l1.53 1.53a3.5 3.5 0 0 1 0 4.94L13 11l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z" },
            { t: "path", d: "M20 2h2v2a4 4 0 0 1-4 4h-2V6a4 4 0 0 1 4-4Z" },
            { t: "path", d: "M11.47 17.47 13 19l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L5 19l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z" },
            { t: "path", d: "M15.47 13.47 17 15l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L9 15l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z" },
            { t: "path", d: "M19.47 9.47 21 11l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L13 11l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z" },
        ]
    },
    {
        id: "carrot", label: "Crops", node: [
            { t: "path", d: "M2.27 21.7s9.87-3.5 12.73-6.36a4.5 4.5 0 0 0-6.36-6.37C5.77 11.84 2.27 21.7 2.27 21.7zM8.64 14l-2.05-2.04M15.34 15l-2.46-2.46" },
            { t: "path", d: "M22 9s-1.33-2-3.5-2C16.86 7 15 9 15 9s1.33 2 3.5 2S22 9 22 9z" },
            { t: "path", d: "M15 2s-2 1.33-2 3.5S15 9 15 9s2-1.84 2-3.5C17 3.33 15 2 15 2z" },
        ]
    },
    {
        id: "beef", label: "Livestock", node: [
            { t: "path", d: "M16.4 13.7A6.5 6.5 0 1 0 6.28 6.6c-1.1 3.13-.78 3.9-3.18 6.08A3 3 0 0 0 5 18c4 0 8.4-1.8 11.4-4.3" },
            { t: "path", d: "m18.5 6 2.19 4.5a6.48 6.48 0 0 1-2.29 7.2C15.4 20.2 11 22 7 22a3 3 0 0 1-2.68-1.66L2.4 16.5" },
            { t: "circle", cx: 12.5, cy: 8.5, r: 2.5 },
        ]
    },
    {
        id: "fish", label: "Fishing", node: [
            { t: "path", d: "M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z" },
            { t: "path", d: "M18 12v.5" },
            { t: "path", d: "M16 17.93a9.77 9.77 0 0 1 0-11.86" },
            { t: "path", d: "M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33" },
            { t: "path", d: "M10.46 7.26C10.2 5.88 9.17 4.24 8 3h5.8a2 2 0 0 1 1.98 1.67l.23 1.4" },
            { t: "path", d: "m16.01 17.93-.23 1.4A2 2 0 0 1 13.8 21H9.5a5.96 5.96 0 0 0 1.49-3.98" },
        ]
    },
    {
        id: "anchor", label: "Dock", node: [
            { t: "path", d: "M12 6v16" },
            { t: "path", d: "m19 13 2-1a9 9 0 0 1-18 0l2 1" },
            { t: "path", d: "M9 11h6" },
            { t: "circle", cx: 12, cy: 4, r: 2 },
        ]
    },
    {
        id: "ship", label: "Boat", node: [
            { t: "path", d: "M12 10.189V14" },
            { t: "path", d: "M12 2v3" },
            { t: "path", d: "M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6" },
            { t: "path", d: "M19.38 20A11.6 11.6 0 0 0 21 14l-8.188-3.639a2 2 0 0 0-1.624 0L3 14a11.6 11.6 0 0 0 2.81 7.76" },
            { t: "path", d: "M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" },
        ]
    },
    {
        id: "flame", label: "Forge / fire", node: [
            { t: "path", d: "M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4" },
        ]
    },
    {
        id: "droplet", label: "Water", node: [
            { t: "path", d: "M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" },
        ]
    },
    {
        id: "flag", label: "Flag", node: [
            { t: "path", d: "M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" },
        ]
    },
    {
        id: "map-pin", label: "Marker", node: [
            { t: "path", d: "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" },
            { t: "circle", cx: 12, cy: 10, r: 3 },
        ]
    },
    {
        id: "star", label: "Favorite", node: [
            { t: "path", d: "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" },
        ]
    },
    {
        id: "waypoints", label: "Route", node: [
            { t: "path", d: "m10.586 5.414-5.172 5.172" },
            { t: "path", d: "m18.586 13.414-5.172 5.172" },
            { t: "path", d: "M6 12h12" },
            { t: "circle", cx: 12, cy: 20, r: 2 },
            { t: "circle", cx: 12, cy: 4, r: 2 },
            { t: "circle", cx: 20, cy: 12, r: 2 },
            { t: "circle", cx: 4, cy: 12, r: 2 },
        ]
    },
    {
        id: "compass", label: "Compass", node: [
            { t: "circle", cx: 12, cy: 12, r: 10 },
            { t: "path", d: "m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" },
        ]
    },
    {
        id: "landmark", label: "Landmark", node: [
            { t: "path", d: "M10 18v-7" },
            { t: "path", d: "M11.12 2.198a2 2 0 0 1 1.76.006l7.866 3.847c.476.233.31.949-.22.949H3.474c-.53 0-.695-.716-.22-.949z" },
            { t: "path", d: "M14 18v-7" },
            { t: "path", d: "M18 18v-7" },
            { t: "path", d: "M3 22h18" },
            { t: "path", d: "M6 18v-7" },
        ]
    },
    {
        id: "crown", label: "Claim / king", node: [
            { t: "path", d: "M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" },
            { t: "path", d: "M5 21h14" },
        ]
    },
    {
        id: "shield", label: "Defense", node: [
            { t: "path", d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" },
        ]
    },
    {
        id: "swords", label: "PvP", node: [
            { t: "polyline", points: "14.5 17.5 3 6 3 3 6 3 17.5 14.5" },
            { t: "line", x1: 13, y1: 19, x2: 19, y2: 13 },
            { t: "line", x1: 16, y1: 16, x2: 20, y2: 20 },
            { t: "line", x1: 19, y1: 21, x2: 21, y2: 19 },
            { t: "polyline", points: "14.5 6.5 18 3 21 3 21 6 17.5 9.5" },
            { t: "line", x1: 5, y1: 14, x2: 9, y2: 18 },
            { t: "line", x1: 7, y1: 17, x2: 4, y2: 20 },
            { t: "line", x1: 3, y1: 19, x2: 5, y2: 21 },
        ]
    },
    {
        id: "skull", label: "Danger", node: [
            { t: "path", d: "m12.5 17-.5-1-.5 1h1z" },
            { t: "path", d: "M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z" },
            { t: "circle", cx: 15, cy: 12, r: 1 },
            { t: "circle", cx: 9, cy: 12, r: 1 },
        ]
    },
    {
        id: "hammer", label: "Workshop", node: [
            { t: "path", d: "m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9" },
            { t: "path", d: "m18 15 4-4" },
            { t: "path", d: "m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" },
        ]
    },
    {
        id: "package", label: "Goods", node: [
            { t: "path", d: "M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" },
            { t: "path", d: "M12 22V12" },
            { t: "polyline", points: "3.29 7 12 12 20.71 7" },
            { t: "path", d: "m7.5 4.27 9 5.15" },
        ]
    },
    {
        id: "key-round", label: "Key", node: [
            { t: "path", d: "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" },
            { t: "circle", cx: 16.5, cy: 7.5, r: 0.5, fill: true },
        ]
    },
    {
        id: "bed", label: "Spawn / bed", node: [
            { t: "path", d: "M2 4v16" },
            { t: "path", d: "M2 8h18a2 2 0 0 1 2 2v10" },
            { t: "path", d: "M2 17h20" },
            { t: "path", d: "M6 8v9" },
        ]
    },
    {
        id: "door-open", label: "Entrance", node: [
            { t: "path", d: "M11 20H2" },
            { t: "path", d: "M11 4.562v16.157a1 1 0 0 0 1.242.97L19 20V5.562a2 2 0 0 0-1.515-1.94l-4-1A2 2 0 0 0 11 4.561z" },
            { t: "path", d: "M11 4H8a2 2 0 0 0-2 2v14" },
            { t: "path", d: "M14 12h.01" },
            { t: "path", d: "M22 20h-3" },
        ]
    },
    {
        id: "circle-alert", label: "Warning", node: [
            { t: "circle", cx: 12, cy: 12, r: 10 },
            { t: "line", x1: 12, y1: 8, x2: 12, y2: 12 },
            { t: "line", x1: 12, y1: 16, x2: 12.01, y2: 16 },
        ]
    },
    {
        id: "circle-help", label: "Question", node: [
            { t: "circle", cx: 12, cy: 12, r: 10 },
            { t: "path", d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" },
            { t: "path", d: "M12 17h.01" },
        ]
    },
    {
        id: "heart", label: "Heart", node: [
            { t: "path", d: "M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" },
        ]
    },
];

export const STAMP_ICON_MAP: Record<string, StampIcon> = Object.fromEntries(
    STAMP_ICONS.map((i) => [i.id, i]),
);

export const DEFAULT_STAMP_ICON_ID = STAMP_ICONS[0].id;

function parsePoints(points: string): [number, number][] {
    const nums = points.trim().split(/[\s,]+/).map(Number);
    const out: [number, number][] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
    return out;
}

/**
 * Draw a stamp icon centred at (cx, cy) at `sizePx`, tinted `color`, with an
 * optional halo `outline`. Alpha is taken from the caller's globalAlpha.
 */
export function drawStampIcon(
    ctx: CanvasRenderingContext2D,
    node: IconPrim[],
    cx: number,
    cy: number,
    sizePx: number,
    color: string,
    outline: { color: string; width: number } | null,
): void {
    const scale = sizePx / 24;
    ctx.save();
    ctx.translate(cx - sizePx / 2, cy - sizePx / 2);
    ctx.scale(scale, scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const paint = (stroke: string, lineWidth: number, strokeOnly: boolean) => {
        ctx.strokeStyle = stroke;
        ctx.fillStyle = stroke;
        ctx.lineWidth = lineWidth;
        for (const p of node) {
            switch (p.t) {
                case "path":
                    ctx.stroke(new Path2D(p.d));
                    break;
                case "circle":
                    ctx.beginPath();
                    ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
                    if (p.fill && !strokeOnly) ctx.fill();
                    else ctx.stroke();
                    break;
                case "line":
                    ctx.beginPath();
                    ctx.moveTo(p.x1, p.y1);
                    ctx.lineTo(p.x2, p.y2);
                    ctx.stroke();
                    break;
                case "polyline":
                case "polygon": {
                    const pts = parsePoints(p.points);
                    if (pts.length === 0) break;
                    ctx.beginPath();
                    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
                    if (p.t === "polygon") ctx.closePath();
                    ctx.stroke();
                    break;
                }
            }
        }
    };

    if (outline) paint(outline.color, 2 + outline.width, true);
    paint(color, 2, false);
    ctx.restore();
}
