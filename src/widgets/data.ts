import { useMemo } from "react";
import { api } from "../../convex/_generated/api";
import type { Overview } from "../../convex/dashboard";
import { metricValue, type DashboardMetric } from "@shared/metrics";
import { percentChange } from "@shared/format";
import type { Platform } from "@shared/platforms";
import type { PlatformFilter } from "@shared/widgets";
import { useToday } from "@/lib/hooks";
import { useSyncedQuery } from "@/lib/sync";

export type MetricView = {
  days: string[];
  series: number[];
  total: number;
  previous: number;
  change: number | undefined;
  byPlatform: { platform: Platform; total: number; previous: number }[];
  hasData: boolean;
};

export function computeMetric(overview: Overview, metric: DashboardMetric, filter: PlatformFilter): MetricView {
  const platforms = overview.platforms.filter((platform) => filter === "all" || platform === filter);
  const series = overview.days.map((_, index) =>
    platforms.reduce((sum, platform) => {
      const day = overview.series[platform]?.[index];
      return day ? sum + metricValue(day, metric) : sum;
    }, 0),
  );
  const byPlatform = platforms.map((platform) => ({
    platform,
    total: (overview.series[platform] ?? []).reduce((sum, day) => sum + metricValue(day, metric), 0),
    previous: overview.previous[platform] ? metricValue(overview.previous[platform]!, metric) : 0,
  }));
  const total = series.reduce((a, b) => a + b, 0);
  const previous = byPlatform.reduce((sum, entry) => sum + entry.previous, 0);
  return {
    days: overview.days,
    series,
    total,
    previous,
    change: percentChange(total, previous),
    byPlatform,
    hasData: platforms.length > 0 && (total > 0 || previous > 0),
  };
}

export function useOverview(range: number) {
  const today = useToday();
  return useSyncedQuery(api.dashboard.overview, { today, days: range });
}

export function useMetric(metric: DashboardMetric, range: number, filter: PlatformFilter): MetricView | null | undefined {
  const overview = useOverview(range);
  return useMemo(() => (overview ? computeMetric(overview, metric, filter) : overview), [overview, metric, filter]);
}
