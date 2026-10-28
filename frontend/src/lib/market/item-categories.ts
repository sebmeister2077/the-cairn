// Shared, in-house "custom category" mapping. The backend derives a raw item
// `category` straight from the item code (e.g. "game:ingot-copper" -> "ingot"),
// which yields 300+ hyper-granular buckets — great for precision, useless as a
// top-level filter. This module folds those raw categories into a small set of
// broad, human-friendly groups (Tools & Weapons, Metals & Ore, …) so the market
// filters can offer a sane high-level "Category" alongside the raw in-game one.
//
// A single mapping drives the custom-category filter on every market surface
// (Items, Listings, Insights). Any raw category not listed here falls back to
// `OTHER_CATEGORY`, so new/unknown game categories degrade gracefully.

/** The broad custom category a raw item category rolls up into. */
export const OTHER_CATEGORY = "Other";

/**
 * Broad group -> the raw in-game categories that belong to it. Keys are the
 * display labels; values are the raw `category` strings (lowercase). Edit here
 * to re-bucket an item type — the reverse lookup and the ordered list below are
 * derived from this table.
 */
const CUSTOM_CATEGORY_MEMBERS: Record<string, string[]> = {
    "Tools & Weapons": [
        "axe", "axehead", "pickaxe", "pickaxehead", "shovel", "shovelhead",
        "hoe", "hoehead", "scythe", "scythehead", "saw", "sawblade",
        "hammer", "hammerhead", "chisel", "knife", "knifeblade", "cleaverhead",
        "blade", "bladehead", "spear", "spearhead", "sword", "club", "mace",
        "bow", "sling", "arrow", "arrowhead", "javelin", "halberd", "poleaxe",
        "paxel", "flail", "file", "rollingpin", "shield", "bomb", "beenade",
        "blastingpowder", "prospectingpick", "prospectingpickhead", "shears",
        "wrench", "crowbar", "solderingiron", "firestarter", "bugnet",
        "fishingpole", "tongsmetal", "wateringcan", "sewingkit",
        "trapcrate",
    ],
    "Metals & Ore": [
        "ore", "crystalizedore", "ingot", "nugget", "metalplate", "crushed",
        "metal", "metalbit", "ironbloom", "solderbar", "metalnailsandstrips",
        "powder", "crucible", "toolmold", "ingotmold", "workitem", "meteorite",
        "charcoal", "coal", "coke", "rod"
    ],
    "Stone & Masonry": [
        "rock", "rockpolished", "polishedrockold", "stone", "stonebricks",
        "stonebrick", "crackedstonebricks", "agedstonebricks", "cobblestone",
        "cobblestonefan", "crackedrock", "drystone", "brickcourse", "burnedbrick",
        "rawbrick", "refractorybrick", "refractorybricks", "claybricks",
        "brickslabs", "claytile", "tile", "shingle", "sand", "gravel",
        "dirtygravel", "muddygravel", "sludgygravel", "clay", "lime", "quicklime",
        "flint", "peatbrick", "ice", "snowblock", "packeddirt", "stonepath",
        "stonepathslab", "stonepathstairs", "mortar"
    ],
    "Wood & Lumber": [
        "log", "logsection", "logquad", "carvedlog", "planks", "plank",
        "plankslab", "burnedplanks", "firewood", "agedfirewood", "stick",
        "stackedbamboo",
    ],
    "Building & Mechanisms": [
        "chiseledblock", "microblock", "door", "metaldoor", "irondoor",
        "trapdoor", "cokeovendoor", "ladder", "glass", "glassslab", "glasspane",
        "daub", "daubraw", "wattle", "plaster", "thatch", "slantedroofingtip",
        "supportbeam", "claybrickchimney", "refractorybrickgrating",
        "woodenfence", "ironfence", "drystonefence", "fencebamboo",
        "bamboostakes", "metalchain", "padlock", "chute", "chutesection",
        "hopper", "trough", "gear", "largegear3", "angledgears", "windmillrotor",
        "waterwheel", "grindingwheel", "woodenaxle", "woodentoggle",
        "pulverizerframe", "pulverizertoggle", "pounder", "poundercap",
        "helvehammer", "helvehammerhead", "helvehammerbase", "hub", "quern",
        "bellows", "forge", "anvil", "clayoven", "lightningrod", "fruitpress",
    ],
    "Containers & Storage": [
        "storagevessel", "lootvessel", "basket", "stationarybasket", "barrel",
        "crate", "chest", "trunk", "bowl", "jug", "crock", "claypot",
        "dirtyclaypot", "backpack", "hunterbackpack", "linensack", "miningbag",
        "miningbagsturdy", "woodbucket",
    ],
    "Clothing & Armor": [
        "clothes", "armor", "hoovedwearables", "hide", "leather", "cloth",
        "linen", "flaxfibers", "flaxtwine",
    ],
    "Food & Cooking": [
        "fruit", "vegetable", "pickledvegetable", "redmeat", "bushmeat",
        "fishraw", "poultry", "cheese", "bread", "pie", "pressedmash",
        "honeymash", "mushroom", "egg", "fat", "spice", "salt", "pineapple",
        "pumpkin", "grain", "flour", "legume", "tuleroot", "cattailroot",
    ],
    "Farming & Plants": [
        "seeds", "treeseed", "sapling", "fruitingbushcutting", "fruittree",
        "clayplanter", "flowerpot", "soil", "bonysoil", "compost", "potash",
        "bonemeal", "hay", "drygrass", "rot", "skep", "honeycomb", "beeswax",
        "papyrusroot", "papyrustops", "cattailtops", "resin",
    ],
    "Decoration & Furniture": [
        "clutter", "tapestry", "taxidermy", "wallpaper", "smallcarpet", "rushmat",
        "bed", "table", "chair", "shelf", "bookshelf", "clutteredbookshelf",
        "displaycase", "talldisplaycase", "chandelier", "candle", "lantern",
        "oillamp", "torch", "torchholder", "plaque", "sign", "antlermount",
        "omokpiece", "omoktabletop", "instrument", "altar", "armorstand",
        "cobbleskull", "quartzpillar", "resonator", "tuningcylinder",
        "jonasframes",
    ],
    "Books & Art": [
        "book", "lore", "painting", "letter", "paper", "inkandquill",
        "schematic", "locatormap",
    ],
    "Gems & Minerals": [
        "crystal", "gem", "amethyst", "smokyquartz", "rosequartz", "clearquartz",
        "diamond",
    ],
    "Animals & Nature": [
        "flower", "seashell", "coral", "coralchunk", "antler", "butterfly",
        "bone", "bonyremains", "feather", "animal", "creature", "aquaticplant",
        "waterlily", "fern", "tallfern", "silvertorchcactus", "barrelcactus",
        "attachingplant", "locustnest", "spiderweb", "reefledge", "boss",
    ],
    "Jonas Machines": [
        'corpsereturnteleporter', "nightvisiondevice", "jonasparts", "riftward", "tobtlocatorpart", "nightvisionupgrades",
        "tobtlocator", "basereturnteleporter"
    ]
};

/** Canonical display order for the custom categories (with "Other" last). */
export const CUSTOM_CATEGORIES: string[] = [
    ...Object.keys(CUSTOM_CATEGORY_MEMBERS),
    OTHER_CATEGORY,
];

/** raw category (lowercase) -> broad custom category. */
const RAW_TO_CUSTOM: Record<string, string> = (() => {
    const map: Record<string, string> = {};
    for (const [group, members] of Object.entries(CUSTOM_CATEGORY_MEMBERS)) {
        for (const raw of members) {
            map[raw] = group;
        }
    }
    return map;
})();

/**
 * The broad custom category a raw in-game category belongs to. Unknown or empty
 * categories roll up into {@link OTHER_CATEGORY}.
 */
export function customCategoryFor(rawCategory: string | null | undefined): string {
    if (!rawCategory) return OTHER_CATEGORY;
    return RAW_TO_CUSTOM[rawCategory.toLowerCase()] ?? OTHER_CATEGORY;
}

/**
 * The custom categories actually present in a set of raw categories, returned
 * in canonical display order. Keeps the filter dropdown free of empty buckets.
 */
export function customCategoriesFrom(rawCategories: Iterable<string>): string[] {
    const present = new Set<string>();
    for (const raw of rawCategories) present.add(customCategoryFor(raw));
    return CUSTOM_CATEGORIES.filter((c) => present.has(c));
}
