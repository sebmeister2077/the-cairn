using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using TempStormPredictor;

internal static class Program
{
    private const string Usage =
@"TempStormCli — predict the deterministic temporal storm schedule.

Usage:
  dotnet run -- --seed <int> [options]

Required:
  --seed <int>            World seed (e.g. 421943594).

Options:
  --tier <name>           veryrare|rare|sometimes|often|veryoften  (default: sometimes)
  --count <n>             How many storms to print  (default: 50)
  --start-day <float>     totalDays at world creation when first prepareNextStorm
                          runs. Get this from the mod's first log line, or leave
                          0 to see relative offsets.  (default: 0)
  --freq-mul <float>      worldconfig tempStormFrequencyMul                (default: 1.0)
  --dur-mul  <float>      worldconfig tempstormDurationMul                 (default: 1.0)
  --days-per-month <int>  Server calendar daysPerMonth                     (default: 9)
  --months-per-year <int> Server calendar monthsPerYear                    (default: 12)
  --start-year <int>      VS calendar StartYear (vanilla = 1386)           (default: 1386)
  --min-year <int>        Skip storms whose start year is below this. Simulation
                          still rolls every storm so the schedule stays in sync
                          with the actual server; storms before --min-year are
                          just hidden from the output.                     (default: 1386)
  --csv <path>            Also write CSV to this path.
  --help                  Show this message.

Defaults reflect a fresh 'surviveandbuild' world: tier=sometimes, both muls=1.

The predicted schedule only matches your actual server if the
DeterministicTempStorm mod is installed; see tools/tempstorm-predictor/Mod.
";

    public static int Main(string[] args)
    {
        var argMap = ParseArgs(args);
        if (argMap.ContainsKey("help") || !argMap.ContainsKey("seed"))
        {
            Console.WriteLine(Usage);
            return argMap.ContainsKey("help") ? 0 : 1;
        }

        int seed = int.Parse(argMap["seed"], CultureInfo.InvariantCulture);
        string tierName = argMap.GetValueOrDefault("tier", "sometimes");
        int count = int.Parse(argMap.GetValueOrDefault("count", "50"), CultureInfo.InvariantCulture);
        double startDay = double.Parse(argMap.GetValueOrDefault("start-day", "0"), CultureInfo.InvariantCulture);
        double freqMul = double.Parse(argMap.GetValueOrDefault("freq-mul", "1"), CultureInfo.InvariantCulture);
        double durMul = double.Parse(argMap.GetValueOrDefault("dur-mul", "1"), CultureInfo.InvariantCulture);
        int daysPerMonth = int.Parse(argMap.GetValueOrDefault("days-per-month", "9"), CultureInfo.InvariantCulture);
        int monthsPerYear = int.Parse(argMap.GetValueOrDefault("months-per-year", "12"), CultureInfo.InvariantCulture);
        int startYear = int.Parse(argMap.GetValueOrDefault("start-year", VsCalendar.DefaultStartYear.ToString(CultureInfo.InvariantCulture)), CultureInfo.InvariantCulture);
        int minYear = int.Parse(argMap.GetValueOrDefault("min-year", startYear.ToString(CultureInfo.InvariantCulture)), CultureInfo.InvariantCulture);
        string? csvPath = argMap.GetValueOrDefault("csv");

        if (!StormTiers.All.TryGetValue(tierName, out var tier))
        {
            Console.Error.WriteLine($"Unknown tier '{tierName}'. Allowed: {string.Join(", ", StormTiers.All.Keys)}");
            return 1;
        }

        // Simulate enough storms forward to be able to collect `count` rows that
        // are at or after minYear. We keep the original (true) storm indices so
        // the printed numbers stay in sync with what the actual server will show.
        var allStorms = new List<ScheduledStorm>();
        int collected = 0;
        const int safetyCap = 100_000;
        foreach (var s in TempStormSchedule.Compute(seed, startDay, tier, freqMul, durMul, safetyCap))
        {
            var d = VsCalendar.FromTotalDays(s.StartTotalDays, daysPerMonth, monthsPerYear, startYear);
            if (d.Year < minYear) continue;
            allStorms.Add(s);
            if (++collected >= count) break;
        }
        var schedule = allStorms;

        Console.WriteLine($"Seed: {seed}   Tier: {tier.Name}   freqMul={freqMul}   durMul={durMul}   startDay={startDay}   daysPerMonth={daysPerMonth}   monthsPerYear={monthsPerYear}   startYear={startYear}   minYear={minYear}");
        Console.WriteLine();
        Console.WriteLine($"{"#",4} {"day",12}  {"in-game date",-32}  {"dur(d)",7}  {"strength",-8}  {"strDbl",7}");
        Console.WriteLine(new string('-', 92));
        foreach (var s in schedule)
        {
            Console.WriteLine(
                $"{s.Index,4} {s.StartTotalDays,12:F3}  {VsCalendar.FormatRich(s.StartTotalDays, daysPerMonth, monthsPerYear, startYear),-32}  " +
                $"{s.DurationDays,7:F3}  {s.Strength,-8}  {s.StrengthDouble,7:F3}");
        }

        if (csvPath != null)
        {
            using var w = new StreamWriter(csvPath);
            w.WriteLine("index,start_totaldays,end_totaldays,duration_days,strength,strength_double,start_year,start_month,start_day,start_hour,start_minute");
            foreach (var s in schedule)
            {
                var d = VsCalendar.FromTotalDays(s.StartTotalDays, daysPerMonth, monthsPerYear, startYear);
                w.WriteLine(string.Format(CultureInfo.InvariantCulture,
                    "{0},{1:R},{2:R},{3:R},{4},{5:R},{6},{7},{8},{9},{10}",
                    s.Index, s.StartTotalDays, s.EndTotalDays, s.DurationDays,
                    s.Strength, s.StrengthDouble,
                    d.Year, d.Month, d.DayOfMonth, d.Hour, d.Minute));
            }
            Console.WriteLine($"\nWrote {schedule.Count} rows to {csvPath}");
        }

        return 0;
    }

    private static Dictionary<string, string> ParseArgs(string[] args)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (!a.StartsWith("--", StringComparison.Ordinal)) continue;
            var key = a.Substring(2);
            if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
            {
                map[key] = args[i + 1];
                i++;
            }
            else
            {
                map[key] = "true";
            }
        }
        return map;
    }
}
