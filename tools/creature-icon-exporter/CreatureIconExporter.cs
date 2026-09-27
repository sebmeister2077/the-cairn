// Creature Icon Exporter — a tiny Vintage Story CLIENT mod that renders every
// creature to a transparent PNG, for the Auction House explorer's caught-animal
// market pages (Pig / Chicken / Goat …).
//
// Why a mod: the game's built-in `.blockitempngexport` only renders blocks and
// items, never live entities. But creatures ARE renderable through the ordinary
// item pipeline via the `ItemCreatureInventory` class, which tesselates an
// entity's shape and draws it like an item icon when its stack carries a `type`
// attribute set to the entity code. The base game's `game:creatureinventory`
// item uses this class but ships disabled, so this mod registers its own enabled
// copy (assets/creatureiconexporter/itemtypes/creaturerender.json) and reuses the
// exact framebuffer → RenderItemstackToGui → GrabScreenshot flow the game itself
// uses for `.blockitempngexport`, once per creature type.
//
// Install: drop this single .cs file into  %APPDATA%\Vintagestory\Mods\  (VS
// compiles source-code mods on load — no build step needed).
//
// Use: join any world (creative recommended), then in chat run:
//     .creatureexport                 (all creatures, 128 px)
//     .creatureexport 256             (all creatures, 256 px)
//     .creatureexport 128 pig-*       (only codes starting with "pig-")
//
// Output: %APPDATA%\Vintagestory\icons\creature\<entity-code>.png  — the same
// `icons\` folder `.blockitempngexport` writes to, so the existing
// `python backend/build_item_icons.py --icons-dir …\Vintagestory\icons` run
// ingests them (as `item-creature-<code>` keys) with no extra flags.

using System;
using System.IO;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.Common.Entities;
using Vintagestory.API.Config;

// Mod metadata lives in modinfo.json (this ships as a zipped code mod). Do not
// also add an [assembly: ModInfo] attribute here — VS rejects mods that define
// metadata in both places.

namespace CreatureIconExporter
{
    public class CreatureIconExporterSystem : ModSystem, IRenderer
    {
        private ICoreClientAPI capi;

        // The export touches GL state / the current framebuffer, so it must run
        // on the render thread. The chat command only arms it; the actual work
        // happens on the next Ortho render frame.
        private bool pending;
        private int size = 128;
        private string filter = "*";

        public double RenderOrder => 1.0;
        public int RenderRange => 1;

        public override bool ShouldLoad(EnumAppSide side) => side == EnumAppSide.Client;

        public override void StartClientSide(ICoreClientAPI api)
        {
            capi = api;
            api.Event.RegisterRenderer(this, EnumRenderStage.Ortho, "creatureiconexporter");
            api.ChatCommands.Create("creatureexport")
                .WithDescription("Export transparent PNG icons of every creature to icons/creature/. Args: [size] [codeWildcard].")
                .WithArgs(
                    api.ChatCommands.Parsers.OptionalInt("size", 128),
                    api.ChatCommands.Parsers.OptionalWord("filter"))
                .HandleWith(OnCmd);
        }

        private TextCommandResult OnCmd(TextCommandCallingArgs args)
        {
            size = Math.Clamp((int)args[0], 16, 2048);
            filter = (args[1] as string) ?? "*";
            pending = true;
            return TextCommandResult.Success($"Exporting creature icons at {size}px (filter '{filter}') on the next frame…");
        }

        public void OnRenderFrame(float dt, EnumRenderStage stage)
        {
            if (!pending) return;
            pending = false;
            try
            {
                Export();
            }
            catch (Exception e)
            {
                capi.ShowChatMessage("[creatureexport] failed: " + e.Message);
                capi.Logger.Error(e);
            }
        }

        private void Export()
        {
            IRenderAPI r = capi.Render;

            // Our own item (class ItemCreatureInventory, from VSSurvivalMod) renders
            // any entity by shape when its stack's `type` attribute is the entity
            // code. The base game's `game:creatureinventory` item uses this class too
            // but ships `enabled: false`, so we register our own enabled copy.
            Item creatureItem = capi.World.GetItem(new AssetLocation("creatureiconexporter:creaturerender"));
            if (creatureItem == null)
            {
                // Fallback: any registered item using the ItemCreatureInventory class.
                foreach (Item it in capi.World.Items)
                {
                    if (it?.Code != null && it.GetType().Name == "ItemCreatureInventory")
                    {
                        creatureItem = it;
                        break;
                    }
                }
            }
            if (creatureItem == null)
            {
                capi.ShowChatMessage("[creatureexport] creature render item is missing — is the mod's assets folder present in the zip?");
                return;
            }

            int sz = size;
            FrameBufferRef fb = r.CreateFrameBuffer(new FramebufferAttrs("CreatureIconExport", sz, sz)
            {
                Attachments = new FramebufferAttrsAttachment[]
                {
                    new FramebufferAttrsAttachment
                    {
                        AttachmentType = EnumFramebufferAttachment.ColorAttachment0,
                        Texture = new RawTexture
                        {
                            Width = sz,
                            Height = sz,
                            PixelFormat = EnumTexturePixelFormat.Rgba,
                            PixelInternalFormat = EnumTextureInternalFormat.Rgba8,
                        },
                    },
                    new FramebufferAttrsAttachment
                    {
                        AttachmentType = EnumFramebufferAttachment.DepthAttachment,
                        Texture = new RawTexture
                        {
                            Width = sz,
                            Height = sz,
                            PixelFormat = EnumTexturePixelFormat.DepthComponent,
                            PixelInternalFormat = EnumTextureInternalFormat.DepthComponent32,
                        },
                    },
                },
            });

            FrameBufferRef prevFb = r.CurrentFrameBuffer;
            r.CurrentFrameBuffer = fb;
            r.GLEnableDepthTest();
            r.GlDisableCullFace();
            r.GlToggleBlend(true);
            r.OrthoMode(sz, sz);

            float[] clear = new float[4]; // transparent
            string outDir = Path.Combine(GamePaths.DataPath, "icons", "creature");
            Directory.CreateDirectory(outDir);

            int written = 0;
            int skipped = 0;
            foreach (EntityProperties et in capi.World.EntityTypes)
            {
                if (et?.Code == null) continue;
                string code = et.Code.ToShortString();
                if (!MatchFilter(filter, code)) continue;
                // Entities with no client shape (projectiles, abstract types) can't
                // be drawn — skip rather than emit an empty icon.
                if (et.Client?.LoadedShape == null) { skipped++; continue; }

                ItemStack stack = new ItemStack(creatureItem);
                stack.Attributes.SetString("type", code);

                r.ClearFrameBuffer(fb, clear);
                r.RenderItemstackToGui(
                    new DummySlot(stack),
                    sz / 2.0, sz / 2.0, 500.0, sz / 2f, -1,
                    dt: 0f, shading: true, rotate: false, showStackSize: false);

                BitmapRef bmp = r.GrabScreenshot(sz, sz, scaleScreenshot: false, flip: true, withAlpha: true);
                string fname = code.Replace(':', '-').Replace('/', '-') + ".png";
                bmp.Save(Path.Combine(outDir, fname));
                bmp.Dispose();
                written++;
            }

            r.CurrentFrameBuffer = prevFb;
            r.OrthoMode(r.FrameWidth, r.FrameHeight);
            r.DestroyFrameBuffer(fb);

            capi.ShowChatMessage($"[creatureexport] Wrote {written} creature icons ({skipped} had no shape) to {outDir}");
            capi.Logger.Notification($"[creatureexport] Wrote {written} creature icons to {outDir}");
        }

        // Minimal wildcard: "*" (all), "prefix*" (starts-with), or an exact code.
        private static bool MatchFilter(string filter, string code)
        {
            if (string.IsNullOrEmpty(filter) || filter == "*") return true;
            if (filter.EndsWith("*", StringComparison.Ordinal))
                return code.StartsWith(filter.Substring(0, filter.Length - 1), StringComparison.OrdinalIgnoreCase);
            return string.Equals(filter, code, StringComparison.OrdinalIgnoreCase);
        }

        public override void Dispose() { }
    }
}
