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

Fit mode (back-solve --start-day from observed storm events):
  --fit                   Enable fit mode.
  --fit-year/month/day/hour/minute    First observation (date parts).
  --fit-strength <name>   Light|Medium|Heavy. Filters candidates.
  --fit-event <kind>      imminent | start. 'imminent' means the chat broadcast
                          'A ... temporal storm is imminent' was seen; the storm
                          itself fires up to ~0.02 days (~29 min) later. 'start'
                          means the observed time is when the storm actually
                          began.                                          (default: imminent)
  --fit-obs2-year/month/day/hour/minute/strength/event   Optional second observation.
                          When supplied, candidates from obs1 are validated
                          against obs2 and only those that explain both remain.
  --fit-max-index <int>   Largest storm index to consider  (default: 1000).
  --fit-max-start <float> Search upper bound for start-day (default: 100).
  --fit-top <n>           How many best candidates to print  (default: 10).

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

        if (argMap.ContainsKey("fit"))
        {
            return RunFit(argMap, seed, tier, freqMul, durMul, daysPerMonth, monthsPerYear, startYear);
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

    // Convert an in-game date into the TotalDays value the calendar would report,
    // using the same convention as VsCalendar.FromTotalDays.
    private static double InGameDateToTotalDays(int year, int month, int day, int hour, int minute,
        int daysPerMonth, int monthsPerYear, int startYear)
    {
        int daysPerYear = daysPerMonth * monthsPerYear;
        int wholeDays = (year - startYear) * daysPerYear + (month - 1) * daysPerMonth + (day - 1);
        double frac = (hour * 60 + minute) / (double)(VsCalendar.HoursPerDay * 60);
        return wholeDays + frac;
    }

    // Given seed/tier/muls and a candidate start-day, return storm N's start TotalDays.
    private static double StormStartAt(int seed, double startDay, StormTier tier, double freqMul, double durMul, int n)
    {
        double totalDays = startDay;
        ScheduledStorm last = default;
        for (int i = 0; i <= n; i++)
        {
            last = TempStormSchedule.ComputeOne(seed, i, totalDays, tier, freqMul, durMul);
            totalDays = last.EndTotalDays;
        }
        return last.StartTotalDays;
    }

    // Same but returns the full storm (we need strength too).
    private static ScheduledStorm StormAt(int seed, double startDay, StormTier tier, double freqMul, double durMul, int n)
    {
        double totalDays = startDay;
        ScheduledStorm last = default;
        for (int i = 0; i <= n; i++)
        {
            last = TempStormSchedule.ComputeOne(seed, i, totalDays, tier, freqMul, durMul);
            totalDays = last.EndTotalDays;
        }
        return last;
    }

    private record FitCandidate(int N, double StartDay, double StormDay, StormStrength Strength, double StrengthDouble, double ResidualDays);

    private enum FitEvent { Imminent, Start }

    private static (double targetStormStart, double tolHi, double tolLo) ObservationTarget(
        double observedTotalDays, FitEvent ev)
    {
        // 'imminent' fires the first tick where nextStormTotalDays - TotalDays <= 0.02,
        // so storm start ∈ (observed, observed + 0.02]. Aim for the midpoint.
        // 'start' is the storm start itself; allow a small human-observation slack.
        if (ev == FitEvent.Imminent)
            return (observedTotalDays + 0.01, observedTotalDays + 0.02 + 1e-4, observedTotalDays - 1e-4);
        // ~7 min slack for hand-typed observations.
        const double slack = 0.005;
        return (observedTotalDays, observedTotalDays + slack, observedTotalDays - slack);
    }

    private static FitEvent ParseFitEvent(string? s, FitEvent def)
    {
        if (string.IsNullOrEmpty(s)) return def;
        if (s.Equals("imminent", StringComparison.OrdinalIgnoreCase)) return FitEvent.Imminent;
        if (s.Equals("start", StringComparison.OrdinalIgnoreCase)) return FitEvent.Start;
        throw new ArgumentException($"Bad fit event '{s}'. Use 'imminent' or 'start'.");
    }

    private static int RunFit(Dictionary<string, string> argMap, int seed, StormTier tier, double freqMul, double durMul,
        int daysPerMonth, int monthsPerYear, int startYear)
    {
        if (!argMap.ContainsKey("fit-year") || !argMap.ContainsKey("fit-month") || !argMap.ContainsKey("fit-day"))
        {
            Console.Error.WriteLine("Fit mode requires --fit-year, --fit-month, --fit-day (and optionally --fit-hour, --fit-minute, --fit-strength, --fit-event).");
            return 1;
        }

        int fy = int.Parse(argMap["fit-year"], CultureInfo.InvariantCulture);
        int fm = int.Parse(argMap["fit-month"], CultureInfo.InvariantCulture);
        int fd = int.Parse(argMap["fit-day"], CultureInfo.InvariantCulture);
        int fh = int.Parse(argMap.GetValueOrDefault("fit-hour", "0"), CultureInfo.InvariantCulture);
        int fmi = int.Parse(argMap.GetValueOrDefault("fit-minute", "0"), CultureInfo.InvariantCulture);
        string? fitStr = argMap.GetValueOrDefault("fit-strength");
        StormStrength? wantedStrength = null;
        if (!string.IsNullOrEmpty(fitStr))
        {
            if (!Enum.TryParse<StormStrength>(fitStr, true, out var ws))
            {
                Console.Error.WriteLine($"Bad --fit-strength '{fitStr}'. Use Light|Medium|Heavy.");
                return 1;
            }
            wantedStrength = ws;
        }
        FitEvent fitEv;
        try { fitEv = ParseFitEvent(argMap.GetValueOrDefault("fit-event"), FitEvent.Imminent); }
        catch (ArgumentException ex) { Console.Error.WriteLine(ex.Message); return 1; }

        int maxN = int.Parse(argMap.GetValueOrDefault("fit-max-index", "1000"), CultureInfo.InvariantCulture);
        double maxStart = double.Parse(argMap.GetValueOrDefault("fit-max-start", "100"), CultureInfo.InvariantCulture);
        int topN = int.Parse(argMap.GetValueOrDefault("fit-top", "10"), CultureInfo.InvariantCulture);

        double obs1Days = InGameDateToTotalDays(fy, fm, fd, fh, fmi, daysPerMonth, monthsPerYear, startYear);
        var (target1, hi1, lo1) = ObservationTarget(obs1Days, fitEv);

        Console.WriteLine($"Obs1 ({fitEv}): Year {fy}, Month {fm}, Day {fd}, {fh:D2}:{fmi:D2}  -> totalDays {obs1Days:F4}, target storm-start {target1:F4} (window [{lo1:F4}, {hi1:F4}])");
        if (wantedStrength.HasValue) Console.WriteLine($"  required strength = {wantedStrength}");

        // Optional second observation.
        bool hasObs2 = argMap.ContainsKey("fit-obs2-year");
        double obs2Days = 0, target2 = 0, hi2 = 0, lo2 = 0;
        StormStrength? wanted2 = null;
        if (hasObs2)
        {
            int o2y = int.Parse(argMap["fit-obs2-year"], CultureInfo.InvariantCulture);
            int o2m = int.Parse(argMap["fit-obs2-month"], CultureInfo.InvariantCulture);
            int o2d = int.Parse(argMap["fit-obs2-day"], CultureInfo.InvariantCulture);
            int o2h = int.Parse(argMap.GetValueOrDefault("fit-obs2-hour", "0"), CultureInfo.InvariantCulture);
            int o2mi = int.Parse(argMap.GetValueOrDefault("fit-obs2-minute", "0"), CultureInfo.InvariantCulture);
            string? s2 = argMap.GetValueOrDefault("fit-obs2-strength");
            if (!string.IsNullOrEmpty(s2))
            {
                if (!Enum.TryParse<StormStrength>(s2, true, out var ws2))
                {
                    Console.Error.WriteLine($"Bad --fit-obs2-strength '{s2}'.");
                    return 1;
                }
                wanted2 = ws2;
            }
            FitEvent ev2;
            try { ev2 = ParseFitEvent(argMap.GetValueOrDefault("fit-obs2-event"), FitEvent.Imminent); }
            catch (ArgumentException ex) { Console.Error.WriteLine(ex.Message); return 1; }
            obs2Days = InGameDateToTotalDays(o2y, o2m, o2d, o2h, o2mi, daysPerMonth, monthsPerYear, startYear);
            (target2, hi2, lo2) = ObservationTarget(obs2Days, ev2);
            Console.WriteLine($"Obs2 ({ev2}): Year {o2y}, Month {o2m}, Day {o2d}, {o2h:D2}:{o2mi:D2}  -> totalDays {obs2Days:F4}, target storm-start {target2:F4} (window [{lo2:F4}, {hi2:F4}])");
            if (wanted2.HasValue) Console.WriteLine($"  required strength = {wanted2}");
        }
        Console.WriteLine($"Searching N in [0, {maxN}], startDay in [0, {maxStart}]...\n");

        var hits = new List<(FitCandidate Cand, int? N2, double TotalResidual)>();
        for (int n = 0; n <= maxN; n++)
        {
            double lo = 0, hi = maxStart;
            double yLo = StormStartAt(seed, lo, tier, freqMul, durMul, n);
            double yHi = StormStartAt(seed, hi, tier, freqMul, durMul, n);
            if (target1 < yLo - 1e-6 || target1 > yHi + 1e-6) continue;

            for (int it = 0; it < 60; it++)
            {
                double mid = 0.5 * (lo + hi);
                double y = StormStartAt(seed, mid, tier, freqMul, durMul, n);
                if (y < target1) lo = mid; else hi = mid;
                if (hi - lo < 1e-7) break;
            }
            double bestStart = 0.5 * (lo + hi);
            var s = StormAt(seed, bestStart, tier, freqMul, durMul, n);
            if (wantedStrength.HasValue && s.Strength != wantedStrength.Value) continue;
            if (s.StartTotalDays < lo1 || s.StartTotalDays > hi1) continue;

            double res1 = Math.Abs(s.StartTotalDays - target1);
            var cand = new FitCandidate(n, bestStart, s.StartTotalDays, s.Strength, s.StrengthDouble, s.StartTotalDays - target1);

            if (!hasObs2)
            {
                hits.Add((cand, null, res1));
                continue;
            }

            // Simulate forward and find a storm whose start lands in obs2's window.
            double td = s.EndTotalDays;
            int? matchedN2 = null;
            double matchedRes = double.MaxValue;
            StormStrength? matchedStrength = null;
            int maxForward = Math.Max(50, maxN);
            for (int j = n + 1; j <= n + maxForward; j++)
            {
                var fwd = TempStormSchedule.ComputeOne(seed, j, td, tier, freqMul, durMul);
                td = fwd.EndTotalDays;
                if (fwd.StartTotalDays > hi2 + 5.0) break; // gone past the window
                if (fwd.StartTotalDays < lo2) continue;
                if (fwd.StartTotalDays > hi2) break;
                if (wanted2.HasValue && fwd.Strength != wanted2.Value) continue;
                double r = Math.Abs(fwd.StartTotalDays - target2);
                if (r < matchedRes)
                {
                    matchedRes = r;
                    matchedN2 = j;
                    matchedStrength = fwd.Strength;
                }
            }
            if (matchedN2 == null) continue; // obs2 not satisfied for this candidate
            hits.Add((cand, matchedN2, res1 + matchedRes));
        }

        if (hits.Count == 0)
        {
            Console.WriteLine("No candidates found within constraints. Try widening --fit-max-index / --fit-max-start, loosening strength filters, or double-checking the observed times.");
            return 2;
        }

        var ranked = hits.OrderBy(h => h.TotalResidual).Take(topN).ToList();
        if (hasObs2)
        {
            Console.WriteLine($"{"N1",5} {"N2",5} {"start-day",12}  {"obs1 storm",12}  {"obs2 storm",12}  {"Δ1(d)",8}  {"Δ2(d)",8}  {"strength1",-9}");
            Console.WriteLine(new string('-', 100));
            foreach (var h in ranked)
            {
                double obs2Storm = StormStartAt(seed, h.Cand.StartDay, tier, freqMul, durMul, h.N2!.Value);
                double dObs2 = obs2Storm - target2;
                Console.WriteLine(
                    $"{h.Cand.N,5} {h.N2,5} {h.Cand.StartDay,12:F4}  {h.Cand.StormDay,12:F4}  {obs2Storm,12:F4}  {h.Cand.ResidualDays,8:F4}  {dObs2,8:F4}  {h.Cand.Strength,-9}");
            }
        }
        else
        {
            Console.WriteLine($"{"N",6} {"start-day",12}  {"storm-day",12}  {"in-game date",-32}  {"strength",-8}  {"strDbl",7}  {"Δ-imm(d)",9}");
            Console.WriteLine(new string('-', 110));
            foreach (var h in ranked)
            {
                Console.WriteLine(
                    $"{h.Cand.N,6} {h.Cand.StartDay,12:F4}  {h.Cand.StormDay,12:F4}  {VsCalendar.FormatRich(h.Cand.StormDay, daysPerMonth, monthsPerYear, startYear),-32}  " +
                    $"{h.Cand.Strength,-8}  {h.Cand.StrengthDouble,7:F3}  {h.Cand.ResidualDays,9:F4}");
            }
        }
        Console.WriteLine();
        Console.WriteLine("Re-run without --fit using the chosen --start-day to see the full predicted schedule.");
        return 0;
    }
}
