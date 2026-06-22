using System;
using System.Collections.Generic;

namespace TempStormPredictor;

public enum StormStrength { Light = 0, Medium = 1, Heavy = 2 }

public sealed record StormTier(
    string Name,
    float FreqAvg,
    float FreqVar,
    float StrengthIncrease,
    float StrengthCap);

public static class StormTiers
{
    public static readonly Dictionary<string, StormTier> All = new(StringComparer.OrdinalIgnoreCase)
    {
        ["veryrare"]  = new("veryrare",  30f,  5f,   0.025f, 0.25f),
        ["rare"]      = new("rare",      25f,  5f,   0.05f,  0.5f),
        ["sometimes"] = new("sometimes", 15f,  5f,   0.1f,   1.0f),
        ["often"]     = new("often",     7.5f, 2.5f, 0.15f,  1.5f),
        ["veryoften"] = new("veryoften", 4.5f, 1.5f, 0.2f,   2.0f),
    };
}

public readonly record struct ScheduledStorm(
    int Index,
    double StartTotalDays,
    double EndTotalDays,
    double DurationDays,
    StormStrength Strength,
    double StrengthDouble);

public static class TempStormSchedule
{
    // Per-storm RNG seeding. Mirrored exactly by the mod's Harmony prefix.
    public static int StormSeed(int worldSeed, int stormIndex)
        => unchecked(worldSeed * 73856093 ^ stormIndex * 19349663 ^ 0x5BD1E995);

    // Returns one storm for the given index, given the totalDays at which
    // prepareNextStorm() is invoked (i.e. the end of the previous storm, or
    // world creation for index 0).
    public static ScheduledStorm ComputeOne(
        int worldSeed,
        int stormIndex,
        double schedulingTotalDays,
        StormTier tier,
        double freqMul,
        double durMul)
    {
        var r = new Random(StormSeed(worldSeed, stormIndex));

        // Mirrors SystemTemporalStability.prepareNextStorm():
        //   num = min(cap, strInc * TotalDays / freq.avg)
        double num = Math.Min(
            tier.StrengthCap,
            (double)tier.StrengthIncrease * schedulingTotalDays / (double)tier.FreqAvg);

        // NatFloat UNIFORM(avg, var).nextFloat(1, rand) = avg + (rand.NextDouble()-0.5f)*2f*var
        float u = (float)r.NextDouble() - 0.5f;
        float intervalFloat = tier.FreqAvg + u * 2f * tier.FreqVar;

        // nextStormTotalDays = TotalDays + interval / (1 + num/3) / freqMul
        double interval = (double)intervalFloat / (1.0 + num / 3.0) / freqMul;
        double startDay = schedulingTotalDays + interval;

        // val = num + r.NextDouble()*r.NextDouble() * (double)(float)num * 5.0
        double val = num + r.NextDouble() * r.NextDouble() * (double)(float)num * 5.0;
        int strengthInt = (int)Math.Min(2.0, val);
        double strDouble = Math.Max(0.0, num);

        // Storm duration (from onTempStormTick): (0.1 + strDouble*0.1) * durMul
        double duration = (0.1 + strDouble * 0.1) * durMul;
        double endDay = startDay + duration;

        return new ScheduledStorm(
            stormIndex, startDay, endDay, duration,
            (StormStrength)strengthInt, strDouble);
    }

    public static IEnumerable<ScheduledStorm> Compute(
        int worldSeed,
        double startTotalDays,
        StormTier tier,
        double freqMul = 1.0,
        double durMul = 1.0,
        int count = 100)
    {
        double totalDays = startTotalDays;
        for (int i = 0; i < count; i++)
        {
            var storm = ComputeOne(worldSeed, i, totalDays, tier, freqMul, durMul);
            yield return storm;
            totalDays = storm.EndTotalDays;
        }
    }
}

// VS calendar conversion. The server's calendar parameters (daysPerMonth in
// particular) can be customised — pass actual values from the IGameCalendar.
public readonly record struct InGameDate(int Year, int Month, int DayOfMonth, int Hour, int Minute)
{
    public override string ToString()
        => $"Y{Year} M{Month:D2} D{DayOfMonth} {Hour:D2}:{Minute:D2}";
}

public static class VsCalendar
{
    public const int HoursPerDay = 24;
    // VintagestoryAPI: IGameCalendar.StartYear = 1386. Every world begins with year 1386.
    public const int DefaultStartYear = 1386;

    // Vanilla English month labels (matches assets/game/lang/en.json: month-January..December).
    public static readonly string[] MonthNames =
    {
        "January", "February", "March", "April",
        "May", "June", "July", "August",
        "September", "October", "November", "December",
    };

    public static InGameDate FromTotalDays(double totalDays, int daysPerMonth = 9, int monthsPerYear = 12, int startYear = DefaultStartYear)
    {
        if (daysPerMonth < 1) daysPerMonth = 1;
        if (monthsPerYear < 1) monthsPerYear = 1;
        int daysPerYear = daysPerMonth * monthsPerYear;
        if (totalDays < 0) totalDays = 0;

        int fullDays = (int)Math.Floor(totalDays);
        double fracDay = totalDays - fullDays;

        int year = fullDays / daysPerYear + startYear;
        int doy = fullDays % daysPerYear;
        int month = doy / daysPerMonth + 1;
        int day = doy % daysPerMonth + 1;

        double totalMinutes = fracDay * HoursPerDay * 60.0;
        int hour = ((int)Math.Floor(totalMinutes / 60.0)) % HoursPerDay;
        int minute = (int)Math.Floor(totalMinutes - hour * 60.0);
        if (minute < 0) minute = 0;
        if (minute > 59) minute = 59;
        return new InGameDate(year, month, day, hour, minute);
    }

    public static string FormatRich(double totalDays, int daysPerMonth = 9, int monthsPerYear = 12, int startYear = DefaultStartYear)
    {
        var d = FromTotalDays(totalDays, daysPerMonth, monthsPerYear, startYear);
        var monthName = (d.Month >= 1 && d.Month <= MonthNames.Length)
            ? MonthNames[d.Month - 1]
            : $"M{d.Month}";
        return $"Year {d.Year}, {monthName} {d.DayOfMonth}, {d.Hour:D2}:{d.Minute:D2}";
    }
}
