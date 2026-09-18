// Lookup helpers over the bundled grid-recipe dataset (extracted from the game
// assets by `backend/extract_recipes.py`). Pure + synchronous — the file is
// small enough to import directly. Used to show an item's "fair price from
// ingredients": the summed market value of what it's crafted from.

import raw from "@/assets/GameData/recipes.json";

export interface RecipeIngredient {
    /** Bare item/block code of the ingredient. May be a `prefix-*` wildcard. */
    code: string;
    /** Total amount the recipe consumes (pattern occurrences × per-slot qty). */
    quantity: number;
    /** For a `*` wildcard, the specific variant tokens the recipe allows (e.g.
     *  `["iron", "steel"]` for `metalplate-*`); absent = any catalog match. */
    allowed?: string[];
}

export interface RecipeDef {
    /** How many items the recipe yields (usually 1). */
    output: number;
    ingredients: RecipeIngredient[];
}

interface RecipesData {
    recipes: Record<string, RecipeDef[]>;
}

const DATA = raw as unknown as RecipesData;

/** Bare item code: drop an asset domain prefix (`game:backpack-sturdy` -> …). */
function bare(code: string): string {
    return code.includes(":") ? code.split(":").pop()!.trim() : code;
}

/** Every concrete grid recipe that produces this item code, or null when the
 *  item isn't grid-craftable (or has only variant/wildcard recipes we skip). */
export function lookupRecipes(code: string | null | undefined): RecipeDef[] | null {
    if (!code) return null;
    const r = DATA.recipes[bare(code)];
    return r && r.length > 0 ? r : null;
}
