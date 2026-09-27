# Creature Icon Exporter (Vintage Story client mod)

Renders every creature in the game to a transparent PNG, for the Auction House
explorer's caught-animal market pages (Pig / Chicken / Goat …).

## Why this exists

The game's built-in `.blockitempngexport` only renders **blocks and items**, not
live entities. But creatures *are* renderable through the ordinary item pipeline
via the `game:creature` item (`ItemCreatureInventory`), which tesselates an
entity's shape and draws it as an item icon when its stack carries a `type`
attribute equal to the entity code. This mod reuses the exact framebuffer →
`RenderItemstackToGui` → `GrabScreenshot` flow the game itself uses for
`.blockitempngexport`, once per creature type.

## Install

This ships as a zipped **code mod**: `modinfo.json` + a compiled DLL + an
`assets/` folder. The assets register `creatureiconexporter:creaturerender`, an
enabled copy of the game's (disabled) `ItemCreatureInventory` item, which is what
actually draws each creature's shape.

Build and package it in one step, then it lands in your Mods folder:

```powershell
.\pack.ps1
```

`pack.ps1` builds the DLL and writes a spec-correct zip (forward-slash entries —
Windows' `Compress-Archive` writes backslashes, which VS won't traverse). Do
**not** add an `[assembly: ModInfo]` attribute to the source — the metadata lives
in `modinfo.json`, and VS rejects mods that declare it in both places.

## Use

Join any world (Creative recommended so everything is loaded), then in chat:

```
.creatureexport               # all creatures, 128 px
.creatureexport 256           # all creatures, 256 px
.creatureexport 128 pig-*     # only entity codes starting with "pig-"
```

Output goes to:

```
%APPDATA%\Vintagestory\icons\creature\<entity-code>.png
```

e.g. `pig-eurasian-adult-male.png`, `chicken-hen.png`, `goat-angora-adult-female.png`.

## Feed it into the market explorer

`icons\creature\` sits inside the same `icons\` folder `.blockitempngexport`
writes to, so the existing icon build picks the renders up with no extra flags:

```
python backend/build_item_icons.py --icons-dir "%APPDATA%\Vintagestory\icons" --publish-r2-dev
```

`build_item_icons.py` ingests each `creature/<code>.png` as an `item-creature-<code>`
key; the frontend resolves a listing's animal image by falling back
breed → species across those keys.
