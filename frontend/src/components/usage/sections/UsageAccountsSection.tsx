import { adminUsage } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { setAccountsMinActivityGap } from "@/store/slices/adminUsageFilters";
import { ErrorMsg } from "@/components/usage/ErrorMsg";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import type { UsageGranularity } from "@/lib/api";
import { TimeSeriesChart } from "@/components/usage/TimeSeriesChart";
import { Loading } from "@/components/usage/Loading";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ---------------------------------------------------------------------------
// Section: Accounts — new vs active.
// ---------------------------------------------------------------------------

// Minimum time between an account's creation and a later usage event. Accounts
// whose only activity happened sooner than this are treated as throwaway (e.g.
// a user clearing their browser cache) and excluded from both lines.
const MIN_GAP_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "0", label: "No minimum" },
  { value: "3600", label: "1 hour" },
  { value: "21600", label: "6 hours" },
  { value: "86400", label: "1 day" },
  { value: "259200", label: "3 days" },
  { value: "604800", label: "1 week" },
  { value: "1209600", label: "2 weeks" },
  { value: "2592000", label: "30 days" },
];

export function AccountsSection(props: {
  from: string;
  to: string;
  granularity: UsageGranularity;
}) {
  const dispatch = useAppDispatch();
  const minGapSeconds = useAppSelector((s) => s.adminUsageFilters.accountsMinActivityGapSeconds);
  const minGap = String(minGapSeconds);

  // Accounts with zero lifetime activity are always excluded here.
  const q = useQuery({
    queryKey: ["usage", "api-keys", props.from, props.to, props.granularity, minGap],
    queryFn: ({ signal }) =>
      adminUsage.apiKeys(
        {
          from: props.from,
          to: props.to,
          granularity: props.granularity,
          exclude_unused: true,
          min_activity_gap_seconds: minGapSeconds > 0 ? minGapSeconds : undefined,
        },
        signal,
      ),
  });

  const selectedLabel =
    MIN_GAP_OPTIONS.find((o) => o.value === minGap)?.label ?? "No minimum";

  const merged = q.data
    ? [
        ...q.data.new_keys.map((r) => ({ bucket: r.bucket, series: "new", count: r.count })),
        ...q.data.active_keys.map((r) => ({ bucket: r.bucket, series: "active", count: r.count })),
      ]
    : [];

  return (
    <Card>
      <CardHeader className="space-y-1.5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Accounts</CardTitle>
            <CardDescription>
              New accounts created vs. accounts that made at least one request, per bucket.
              Accounts that never made a request are excluded.
              {minGapSeconds > 0 && (
                <>
                  {" "}
                  Both lines only count accounts that made a usage event at least{" "}
                  <strong>{selectedLabel.toLowerCase()}</strong> after being created.
                </>
              )}
            </CardDescription>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="accounts-min-gap" className="text-xs text-muted-foreground">
              Min. activity gap
            </Label>
            <Select
              id="accounts-min-gap"
              value={minGap}
              onValueChange={(v) => dispatch(setAccountsMinActivityGap(Number(v ?? "0")))}
            >
              <SelectTrigger className="h-9 min-w-[9rem]">
                <SelectValue>{() => selectedLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {MIN_GAP_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Loading />
        ) : q.isError || !q.data ? (
          <ErrorMsg msg="Failed to load api-key stats." />
        ) : (
          <TimeSeriesChart
            data={merged}
            xKey="bucket"
            yKey="count"
            seriesKey="series"
            granularity={props.granularity}
          />
        )}
      </CardContent>
    </Card>
  );
}
