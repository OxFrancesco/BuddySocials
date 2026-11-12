import type { ComponentType } from "react";
import { PLATFORM_LABEL, type Platform } from "@shared/platforms";
import { WIDGET_SIZES, type WidgetConfig, type WidgetInstance, type WidgetType } from "@shared/widgets";
import { GoalsBody, InboxBody, LatestPostBody, TopPostsBody } from "./content";
import { Frame } from "./frame";
import { MetricBody, MixBody, PlatformBody, SplitBody, TrendBody, titleFor, type WidgetBodyProps } from "./stats";

/** `logo`: the widget follows one platform, shown as its logo before the title. */
const BODIES: Record<WidgetType, { Body: ComponentType<WidgetBodyProps>; title: (config: WidgetConfig) => string; logo?: boolean }> = {
  metric: { Body: MetricBody, title: (config) => titleFor(config, "Number"), logo: true },
  trend: { Body: TrendBody, title: (config) => titleFor(config, "Trend"), logo: true },
  split: { Body: SplitBody, title: (config) => `${titleFor({ ...config, platform: "all" }, "")} · by platform` },
  topPosts: { Body: TopPostsBody, title: (config) => `Top posts · ${titleFor(config, "")}`, logo: true },
  latestPost: { Body: LatestPostBody, title: () => "Latest post", logo: true },
  inbox: { Body: InboxBody, title: () => "Inbox", logo: true },
  goals: { Body: GoalsBody, title: () => "Goals" },
  mix: { Body: MixBody, title: (config) => titleFor({ ...config, platform: "all" }, "") },
  platform: {
    Body: PlatformBody,
    title: (config) => `${config.platform === "all" ? "All" : PLATFORM_LABEL[config.platform]} · ${config.range}d`,
  },
};

export type Cell = { cell: number; rowHeight: number; gap: number; cols: number };

export function tileSize(widget: Pick<WidgetInstance, "size">, grid: Cell) {
  const spec = WIDGET_SIZES[widget.size];
  const cols = Math.min(spec.cols, grid.cols);
  const rows = spec.rows;
  return {
    cols,
    rows,
    width: cols * grid.cell + (cols - 1) * grid.gap,
    height: rows * grid.rowHeight + (rows - 1) * grid.gap,
  };
}

export function Widget({ widget, grid, onPress, sizeOverride }: { widget: WidgetInstance; grid: Cell; onPress?: () => void; sizeOverride?: { width: number; height: number } }) {
  const entry = BODIES[widget.type];
  const size = tileSize(widget, grid);
  const width = sizeOverride?.width ?? size.width;
  const height = sizeOverride?.height ?? size.height;
  return (
    <Frame
      title={entry.title(widget.config)}
      platform={entry.logo && widget.config.platform !== "all" ? (widget.config.platform as Platform) : undefined}
      width={width} height={height} onPress={onPress} testID={`widget-${widget.id}`}>
      <entry.Body config={widget.config} width={width} height={height} cols={size.cols} rows={size.rows} />
    </Frame>
  );
}
