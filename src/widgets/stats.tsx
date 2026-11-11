import { useMemo } from "react";
import { View } from "react-native";
import { Area, AreaChart, Bar, BarChart, Sparkline, Tooltip } from "react-native-dither-kit";
import { compact, grouped, percentChange, shortDay, signedPercent } from "@shared/format";
import { METRIC_LABEL, metricValue } from "@shared/metrics";
import { PLATFORM_COLOR, PLATFORM_LABEL, accentFor, type Platform } from "@shared/platforms";
import type { WidgetConfig } from "@shared/widgets";
import { PlatformLogo } from "@/ui/platform-logo";
import { Figure, Label } from "@/ui/text";
import { color } from "@/theme";
import { useMetric, useOverview } from "./data";
import { Empty, Loading, Measured, TILE_PAD } from "./frame";

export type WidgetBodyProps = { config: WidgetConfig; width: number; height: number; cols: number; rows: number };

/** The tile title. A single platform shows as its logo in the frame, so the name isn't repeated here. */
export function titleFor(config: WidgetConfig, kind: string, withMetric = true): string {
  const parts = [withMetric ? METRIC_LABEL[config.metric] : kind];
  parts.push(`${config.range}d`);
  return parts.join(" · ");
}

function Change({ value }: { value: number | undefined }) {
  if (value === undefined || !Number.isFinite(value)) return null;
  return (
    <Label size={11} tone={value < 0 ? "coral" : "fg"}>
      {signedPercent(value)}
    </Label>
  );
}

/** Lets a chart run to the tile's edges and bottom so it reads as part of the card, not a box inside it. */
function Bleed({ children, sides = "all" }: { children: React.ReactNode; sides?: "all" | "right" }) {
  return (
    <View
      style={{
        flex: 1,
        marginLeft: sides === "all" ? -TILE_PAD : 0,
        marginRight: -TILE_PAD,
        marginBottom: -TILE_PAD,
      }}
    >
      {children}
    </View>
  );
}

export function MetricBody({ config, width, height, cols }: WidgetBodyProps) {
  const data = useMetric(config.metric, config.range, config.platform);
  if (data === undefined) return <Loading />;
  if (data === null || !data.hasData) return <Empty />;
  if (cols === 1) {
    return (
      <View style={{ flex: 1, gap: 8 }}>
        <View style={{ gap: 4 }}>
          <Figure size={Math.min(34, height * 0.2)} numberOfLines={1} adjustsFontSizeToFit>
            {compact(data.total)}
          </Figure>
          <Change value={data.change} />
        </View>
        <Bleed>
          <Sparkline data={data.series} color={accentFor(config.platform, color.coral)} variant="gradient" animate style={{ flex: 1, minHeight: 0 }} />
        </Bleed>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, flexDirection: "row", gap: 12 }}>
      <View style={{ minWidth: width * 0.38, justifyContent: "flex-end", gap: 6 }}>
        <Figure size={Math.min(48, height * 0.36)} numberOfLines={1} adjustsFontSizeToFit>
          {compact(data.total)}
        </Figure>
        <Change value={data.change} />
      </View>
      <Bleed sides="right">
        <View style={{ flex: 1, paddingTop: height * 0.15 }}>
          <Sparkline data={data.series} color={accentFor(config.platform, color.coral)} variant="gradient" animate style={{ flex: 1, minHeight: 0 }} />
        </View>
      </Bleed>
    </View>
  );
}

export function TrendBody({ config, rows }: WidgetBodyProps) {
  const data = useMetric(config.metric, config.range, config.platform);
  if (data === undefined) return <Loading />;
  if (data === null || !data.hasData) return <Empty />;
  const rowsData = data.days.map((day, index) => ({ day, value: data.series[index] ?? 0 }));
  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <Figure size={rows === 1 ? 26 : 34}>{rows === 1 ? compact(data.total) : grouped(data.total)}</Figure>
        <Change value={data.change} />
      </View>
      <Bleed>
        <Measured>
          {({ height }) => (
            <AreaChart
              data={rowsData}
              config={{ value: { label: METRIC_LABEL[config.metric], color: accentFor(config.platform, color.coral) } }}
              style={{ height, minHeight: 0 }}
              margins={{ top: 6, right: 0, bottom: 0, left: 0 }}
              animate
            >
              <Area dataKey="value" variant="gradient" />
              <Tooltip labelKey="day" valueFormatter={(value) => grouped(value)} />
            </AreaChart>
          )}
        </Measured>
      </Bleed>
    </View>
  );
}

export function SplitBody({ config, rows }: WidgetBodyProps) {
  const data = useMetric(config.metric, config.range, "all");
  if (data === undefined) return <Loading />;
  if (data === null || !data.hasData) return <Empty />;
  const bars = data.byPlatform
    .filter((entry) => entry.total > 0 || entry.previous > 0)
    .sort((a, b) => b.total - a.total)
    .map((entry) => ({ platform: entry.platform, label: PLATFORM_LABEL[entry.platform], current: entry.total, previous: entry.previous }));
  return (
    <View style={{ flex: 1, gap: 8 }}>
      {rows === 1 ? null : (
        <View style={{ flexDirection: "row", gap: 16 }}>
          <LegendSwatch fill={color.coral} label={`Last ${config.range}d`} />
          <LegendSwatch fill={color.fg} dotted label="Previous" />
        </View>
      )}
      <Bleed>
        <Measured>
          {({ height }) => (
            <BarChart
              data={bars}
              config={{
                current: { label: `Last ${config.range}d`, color: color.coral },
                previous: { label: "Previous", color: "#FFFFFF" },
              }}
              style={{ height, minHeight: 0 }}
              margins={{ top: 4, right: 8, bottom: 0, left: 8 }}
              animate
            >
              <Bar dataKey="current" variant="gradient" />
              <Bar dataKey="previous" variant="dotted" />
              <Tooltip labelKey="label" valueFormatter={(value) => grouped(value)} />
            </BarChart>
          )}
        </Measured>
        {/* Logos under each pair of bars, in place of a text axis. */}
        <View style={{ flexDirection: "row", paddingHorizontal: 8, paddingTop: 6, paddingBottom: 10 }}>
          {bars.map((bar) => (
            <View key={bar.platform} style={{ flex: 1, alignItems: "center" }}>
              <PlatformLogo platform={bar.platform} size={12} />
            </View>
          ))}
        </View>
      </Bleed>
    </View>
  );
}

function LegendSwatch({ fill, label, dotted }: { fill: string; label: string; dotted?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 8, height: 8, backgroundColor: dotted ? "transparent" : fill, borderWidth: dotted ? 1 : 0, borderColor: fill, borderStyle: dotted ? "dotted" : "solid" }} />
      <Label size={10}>{label}</Label>
    </View>
  );
}

export function PlatformBody({ config, height, cols }: WidgetBodyProps) {
  const overview = useOverview(config.range);
  const views = useMetric("views", config.range, config.platform);
  if (overview === undefined || views === undefined) return <Loading />;
  const platform = config.platform as Platform;
  if (overview === null || views === null || !overview.platforms.includes(platform)) return <Empty text="Not connected" />;
  const followers = overview.followersTotal[platform];
  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 16 }}>
        {followers !== undefined && followers > 0 ? (
          <View style={{ gap: 2 }}>
            <Figure size={Math.min(30, height * 0.18)}>{compact(followers)}</Figure>
            <Label size={10}>Followers</Label>
          </View>
        ) : null}
        {cols > 1 && views.total > 0 ? (
          <View style={{ gap: 2 }}>
            <Figure size={Math.min(30, height * 0.18)}>{compact(views.total)}</Figure>
            <Label size={10}>Views</Label>
          </View>
        ) : null}
      </View>
      {views.hasData ? (
        <Bleed>
          <Sparkline data={views.series} color={accentFor(config.platform, color.coral)} variant="gradient" animate style={{ flex: 1, minHeight: 0 }} />
        </Bleed>
      ) : null}
    </View>
  );
}

type MixEntry = { platform: Platform; total: number; change: number | undefined; days: number[] };

/** Each connected platform as its own coloured series: overlapping lines, stacked days, side-by-side weeks, or one bar each. */
export function MixBody({ config, rows, cols }: WidgetBodyProps) {
  const overview = useOverview(config.range);
  const entries = useMemo<MixEntry[] | null | undefined>(() => {
    if (!overview) return overview;
    return overview.platforms
      .map((platform) => {
        const days = overview.days.map((_, index) => {
          const day = overview.series[platform]?.[index];
          return day ? metricValue(day, config.metric) : 0;
        });
        const total = days.reduce((a, b) => a + b, 0);
        const previous = overview.previous[platform] ? metricValue(overview.previous[platform]!, config.metric) : 0;
        return { platform, total, change: percentChange(total, previous), days };
      })
      .filter((entry) => entry.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [overview, config.metric]);

  if (entries === undefined || overview === undefined) return <Loading />;
  if (entries === null || overview === null || entries.length === 0) return <Empty />;

  const chart = config.chart ?? "lines";
  const chartConfig = Object.fromEntries(
    entries.map((entry) => [entry.platform, { label: PLATFORM_LABEL[entry.platform], color: PLATFORM_COLOR[entry.platform] }]),
  );
  let data: Record<string, number | string>[];
  if (chart === "bars") {
    data = entries.map((entry) => ({
      label: PLATFORM_LABEL[entry.platform],
      ...Object.fromEntries(entries.map((other) => [other.platform, other.platform === entry.platform ? entry.total : 0])),
    }));
  } else {
    const bucket = chart === "weeks" && overview.days.length > 7 ? 7 : 1;
    const count = Math.ceil(overview.days.length / bucket);
    data = Array.from({ length: count }, (_, index) => {
      // Buckets end on today, so a partial bucket sits at the start.
      const end = overview.days.length - (count - 1 - index) * bucket;
      const start = Math.max(0, end - bucket);
      return {
        label: shortDay(overview.days[start]!),
        ...Object.fromEntries(entries.map((entry) => [entry.platform, entry.days.slice(start, end).reduce((a, b) => a + b, 0)])),
      };
    });
  }
  const showChange = chart === "bars" && (rows > 1 || cols >= 4);

  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 4 }}>
        {entries.map((entry) => (
          <View key={entry.platform} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {/* The logo in the series colour doubles as the legend swatch. */}
            <PlatformLogo platform={entry.platform} size={11} tint={PLATFORM_COLOR[entry.platform]} />
            <Label size={10} tone="fg">
              {compact(entry.total)}
            </Label>
            {showChange && entry.change !== undefined ? (
              <Label size={10} tone={entry.change < 0 ? "coral" : "dim"}>
                {signedPercent(entry.change)}
              </Label>
            ) : null}
          </View>
        ))}
      </View>
      <Bleed>
        <Measured>
          {({ height }) =>
            chart === "lines" ? (
              <AreaChart data={data} config={chartConfig} style={{ height, minHeight: 0 }} margins={{ top: 6, right: 0, bottom: 0, left: 0 }} animate>
                {/* Biggest platform first so the smaller areas draw over it. */}
                {entries.map((entry) => (
                  <Area key={entry.platform} dataKey={entry.platform} variant="gradient" />
                ))}
                <Tooltip labelKey="label" valueFormatter={(value) => grouped(value)} />
              </AreaChart>
            ) : (
              <BarChart
                data={data}
                config={chartConfig}
                stackType={chart === "weeks" ? "default" : "stacked"}
                style={{ height, minHeight: 0 }}
                margins={{ top: 4, right: 0, bottom: 0, left: 0 }}
                animate
              >
                {entries.map((entry) => (
                  <Bar key={entry.platform} dataKey={entry.platform} variant="gradient" />
                ))}
                <Tooltip labelKey="label" valueFormatter={(value) => grouped(value)} />
              </BarChart>
            )
          }
        </Measured>
      </Bleed>
    </View>
  );
}
