using System;
using System.Globalization;
using System.IO;
using System.Linq;
using HarmonyLib;
using TempStormPredictor;
using Vintagestory.API.Common;
using Vintagestory.API.Config;
using Vintagestory.API.Server;
using Vintagestory.GameContent;

namespace DeterministicTempStorm;

public class DeterministicTempStormMod : ModSystem
{
    internal static ICoreServerAPI? Sapi;
    internal static int WorldSeed;
    internal static int StormIndex;
    internal static StormTier Tier = StormTiers.All["sometimes"];
    internal static double FreqMul = 1.0;
    internal static double DurMul = 1.0;
    internal static int DaysPerMonth = 9;
    internal static int MonthsPerYear = 12;
    internal static int StartYear = VsCalendar.DefaultStartYear;

    private const string SaveKey = "deterministicTempStormIndex";
    private Harmony? harmony;

    public override bool ShouldLoad(EnumAppSide forSide) => forSide == EnumAppSide.Server;

    public override void StartServerSide(ICoreServerAPI api)
    {
        Sapi = api;
        // Default so the postfix is safe even if VSSurvivalMod's SaveGameLoaded
        // handler (which calls prepareNextStorm on a new world) fires before ours.
        // OnSaveGameLoaded below overwrites this with the persisted value if any.
        StormIndex = 0;

        harmony = new Harmony("sebas.deterministictempstorm");
        harmony.PatchAll(typeof(DeterministicTempStormMod).Assembly);

        api.Event.SaveGameLoaded += OnSaveGameLoaded;
        api.Event.GameWorldSave += OnGameWorldSave;

        api.ChatCommands.Create("tempstormschedule")
            .WithDescription("Dump the deterministic temporal storm schedule to a CSV file.")
            .RequiresPrivilege(Privilege.controlserver)
            .HandleWith(args =>
            {
                var path = WriteScheduleCsv(200);
                return TextCommandResult.Success($"Wrote schedule to {path}");
            });
    }

    public override void Dispose()
    {
        harmony?.UnpatchAll("sebas.deterministictempstorm");
        base.Dispose();
    }

    private void OnSaveGameLoaded()
    {
        if (Sapi == null) return;

        WorldSeed = Sapi.World.Seed;

        var tierName = Sapi.World.Config.GetString("temporalStorms", "sometimes") ?? "sometimes";
        Tier = StormTiers.All.TryGetValue(tierName, out var t) ? t : StormTiers.All["sometimes"];
        FreqMul = (double)Sapi.World.Config.GetDecimal("tempStormFrequencyMul", 1.0);
        DurMul = (double)Sapi.World.Config.GetDecimal("tempstormDurationMul", 1.0);

        DaysPerMonth = Sapi.World.Calendar.DaysPerMonth;
        int daysPerYear = Sapi.World.Calendar.DaysPerYear;
        MonthsPerYear = (DaysPerMonth > 0) ? Math.Max(1, daysPerYear / DaysPerMonth) : 12;
        // Vanilla IGameCalendar.StartYear is the const 1386. Recover the actual
        // start year from current Year - elapsed years in case a mod changed it.
        if (daysPerYear > 0)
            StartYear = Sapi.World.Calendar.Year - ((int)Sapi.World.Calendar.TotalDays) / daysPerYear;

        var bytes = Sapi.WorldManager.SaveGame.GetData(SaveKey);
        if (bytes != null && bytes.Length >= 4)
            StormIndex = BitConverter.ToInt32(bytes, 0);
        else
            StormIndex = 0;

        Sapi.Logger.Notification(
            "[DeterministicTempStorm] seed={0} tier={1} freqMul={2} durMul={3} stormIndex={4} startTotalDays={5:F3} daysPerMonth={6} monthsPerYear={7} startYear={8}",
            WorldSeed, Tier.Name, FreqMul, DurMul, StormIndex, Sapi.World.Calendar.TotalDays, DaysPerMonth, MonthsPerYear, StartYear);

        var existing = Sapi.ModLoader.GetModSystem<SystemTemporalStability>()?.StormData;
        if (existing != null)
        {
            Sapi.Logger.Notification(
                "[DeterministicTempStorm] pre-existing: nowActive={0} nextStormTotalDays={1:F3} ({2}) strength={3} strDbl={4:F3}",
                existing.nowStormActive,
                existing.nextStormTotalDays,
                VsCalendar.FormatRich(existing.nextStormTotalDays, DaysPerMonth, MonthsPerYear, StartYear),
                existing.nextStormStrength,
                existing.nextStormStrDouble);
        }

        try
        {
            var path = WriteScheduleCsv(200);
            Sapi.Logger.Notification("[DeterministicTempStorm] schedule -> {0}", path);
        }
        catch (Exception ex)
        {
            Sapi.Logger.Warning("[DeterministicTempStorm] schedule dump failed: {0}", ex.Message);
        }
    }

    private void OnGameWorldSave()
    {
        if (Sapi == null) return;
        Sapi.WorldManager.SaveGame.StoreData(SaveKey, BitConverter.GetBytes(StormIndex));
    }

    private string WriteScheduleCsv(int count)
    {
        if (Sapi == null) throw new InvalidOperationException("API not ready");

        var dir = Sapi.GetOrCreateDataPath("DeterministicTempStorm");
        var path = Path.Combine(dir, $"tempstorms_seed{WorldSeed}.csv");

        double nowTotalDays = Sapi.World.Calendar.TotalDays;

        // If there is a pre-existing scheduled storm in the future (set by the
        // game's non-deterministic code, e.g. before the mod was installed),
        // use *that* as the first row, then chain our deterministic algorithm
        // from when that storm ends. Otherwise schedule from now.
        var existing = Sapi.ModLoader.GetModSystem<SystemTemporalStability>()?.StormData;
        bool hasExisting = existing != null
            && existing.nextStormTotalDays > nowTotalDays
            && !existing.nowStormActive;

        double chainFromDay;
        ScheduledStorm? preExisting = null;
        if (hasExisting)
        {
            double existingDuration = (0.1 + existing!.nextStormStrDouble * 0.1) * DurMul;
            preExisting = new ScheduledStorm(
                Index: -1,
                StartTotalDays: existing.nextStormTotalDays,
                EndTotalDays: existing.nextStormTotalDays + existingDuration,
                DurationDays: existingDuration,
                Strength: (StormStrength)(int)existing.nextStormStrength,
                StrengthDouble: existing.nextStormStrDouble);
            chainFromDay = preExisting.Value.EndTotalDays;
        }
        else
        {
            chainFromDay = nowTotalDays;
        }

        var schedule = TempStormSchedule
            .Compute(WorldSeed, chainFromDay, Tier, FreqMul, DurMul, count)
            .ToList();

        using var w = new StreamWriter(path);
        w.WriteLine("# seed={0} tier={1} freqMul={2} durMul={3} nowTotalDays={4} chainFromDay={5} startIndex={6} daysPerMonth={7} monthsPerYear={8} startYear={9} hasPreExisting={10}",
            WorldSeed, Tier.Name, FreqMul.ToString(CultureInfo.InvariantCulture),
            DurMul.ToString(CultureInfo.InvariantCulture),
            nowTotalDays.ToString(CultureInfo.InvariantCulture),
            chainFromDay.ToString(CultureInfo.InvariantCulture),
            StormIndex, DaysPerMonth, MonthsPerYear, StartYear, hasExisting);
        w.WriteLine("index_from_now,start_totaldays,end_totaldays,duration_days,strength,strength_double,start_year,start_month,start_day,start_hour,start_minute,source");

        void writeRow(ScheduledStorm s, string source)
        {
            var d = VsCalendar.FromTotalDays(s.StartTotalDays, DaysPerMonth, MonthsPerYear, StartYear);
            w!.WriteLine(string.Format(CultureInfo.InvariantCulture,
                "{0},{1:R},{2:R},{3:R},{4},{5:R},{6},{7},{8},{9},{10},{11}",
                s.Index, s.StartTotalDays, s.EndTotalDays, s.DurationDays,
                s.Strength, s.StrengthDouble,
                d.Year, d.Month, d.DayOfMonth, d.Hour, d.Minute, source));
        }

        if (preExisting.HasValue) writeRow(preExisting.Value, "pre-existing");
        foreach (var s in schedule) writeRow(s, "deterministic");
        return path;
    }
}

[HarmonyPatch(typeof(SystemTemporalStability), "prepareNextStorm")]
internal static class Patch_prepareNextStorm
{
    private static void Postfix(SystemTemporalStability __instance)
    {
        if (DeterministicTempStormMod.Sapi == null) return;

        // WorldSeed is 0 until OnSaveGameLoaded runs; on a brand-new world the
        // very first prepareNextStorm() may fire before our handler. In that
        // case, populate from the world API now.
        if (DeterministicTempStormMod.WorldSeed == 0)
            DeterministicTempStormMod.WorldSeed = DeterministicTempStormMod.Sapi.World.Seed;

        var data = __instance.StormData;
        double totalDaysNow = DeterministicTempStormMod.Sapi.World.Calendar.TotalDays;

        // Storm we're scheduling now uses index 0 for the very first call after world creation.
        var storm = TempStormSchedule.ComputeOne(
            DeterministicTempStormMod.WorldSeed,
            DeterministicTempStormMod.StormIndex,
            totalDaysNow,
            DeterministicTempStormMod.Tier,
            DeterministicTempStormMod.FreqMul,
            DeterministicTempStormMod.DurMul);

        data.nextStormTotalDays = storm.StartTotalDays;
        data.nextStormStrength = (EnumTempStormStrength)(int)storm.Strength;
        data.nextStormStrDouble = storm.StrengthDouble;

        DeterministicTempStormMod.Sapi.Logger.Notification(
            "[DeterministicTempStorm] scheduled storm #{0}: start={1:F3} ({2}) strength={3}",
            DeterministicTempStormMod.StormIndex,
            storm.StartTotalDays,
            VsCalendar.FormatRich(storm.StartTotalDays, DeterministicTempStormMod.DaysPerMonth, DeterministicTempStormMod.MonthsPerYear, DeterministicTempStormMod.StartYear),
            storm.Strength);

        DeterministicTempStormMod.StormIndex++;
    }
}
