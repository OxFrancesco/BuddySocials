import { View } from "react-native";
import { Area, AreaChart, Bar, BarChart, Sparkline, Tooltip, XAxis } from "react-native-dither-kit";
import { compact, grouped, signedPercent } from "@shared/format";
import { METRIC_LABEL } from "@shared/metrics";
import { PLATFORM_TAG, type Platform } from "@shared/platforms";
import type { WidgetConfig } from "@shared/widgets";
import { Figure, Label } from "@/ui/text";
import { color } from "@/theme";
import { useMetric, useOverview } from "./data";
import { Empty, Loading, Measured, TILE_PAD } from "./frame";

export type WidgetBodyProps = { config: WidgetConfig; width: number; height: number; cols: number; rows: number };

export function titleFor(config: WidgetConfig, kind: string, withMetric = true): string {
  const parts = [withMetric ? METRIC_LABEL[config.metric] : kind];
  if (config.platform !== "all") parts.push(PLATFORM_TAG[config.platform]);
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
          <Sparkline data={data.series} color={color.coral} variant="gradient" animate style={{ flex: 1, minHeight: 0 }} />
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
          <Sparkline data={data.series} color={color.coral} variant="gradient" animate style={{ flex: 1, minHeight: 0 }} />
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
              config={{ value: { label: METRIC_LABEL[config.metric], color: color.coral } }}
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
    .map((entry) => ({ platform: PLATFORM_TAG[entry.platform], current: entry.total, previous: entry.previous }));
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
              margins={{ top: 4, right: 8, bottom: 26, left: 8 }}
              animate
            >
              <XAxis dataKey="platform" />
              <Bar dataKey="current" variant="gradient" />
              <Bar dataKey="previous" variant="dotted" />
              <Tooltip labelKey="platform" valueFormatter={(value) => grouped(value)} />
            </BarChart>
          )}
        </Measured>
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
          <Sparkline data={views.series} color={color.coral} variant="gradient" animate style={{ flex: 1, minHeight: 0 }} />
        </Bleed>
      ) : null}
    </View>
  );
}
