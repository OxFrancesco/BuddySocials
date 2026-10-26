import { DASHBOARD_METRICS, type DashboardMetric } from "./metrics";
import { isPlatform, type Platform } from "./platforms";

/**
 * Grid footprint of a widget. The home grid has 2 columns on the cover screen
 * and 4 when the Fold is open; wider sizes clamp to the available columns.
 */
export const WIDGET_SIZES = {
  s: { cols: 1, rows: 1, label: "Small" },
  m: { cols: 2, rows: 1, label: "Medium" },
  l: { cols: 2, rows: 2, label: "Large" },
  w: { cols: 4, rows: 1, label: "Wide" },
  xl: { cols: 4, rows: 2, label: "Extra large" },
} as const;

export type WidgetSize = keyof typeof WIDGET_SIZES;

export const RANGES = [7, 28, 90] as const;
export type RangeDays = (typeof RANGES)[number];

export type PlatformFilter = Platform | "all";

/** How the platform mix widget draws: overlapping lines, stacked days, side-by-side weeks, or one bar per platform. */
export const MIX_CHARTS = ["lines", "days", "weeks", "bars"] as const;
export type MixChart = (typeof MIX_CHARTS)[number];
export const MIX_CHART_LABEL: Record<MixChart, string> = { lines: "Areas", days: "Days", weeks: "Weeks", bars: "Platforms" };

export type WidgetConfig = {
  metric: DashboardMetric;
  range: RangeDays;
  platform: PlatformFilter;
  chart?: MixChart;
};

export type WidgetType =
  | "metric"
  | "trend"
  | "split"
  | "topPosts"
  | "latestPost"
  | "inbox"
  | "platform"
  | "goals"
  | "mix";

export type WidgetInstance = {
  id: string;
  type: WidgetType;
  size: WidgetSize;
  config: WidgetConfig;
};

type WidgetDefinition = {
  readonly title: string;
  readonly description: string;
  readonly sizes: readonly WidgetSize[];
  /** Which settings the widget reads. Unused settings are hidden in the editor. */
  readonly settings: readonly (keyof WidgetConfig)[];
  readonly defaults: WidgetConfig;
  /** "all" is not offered when the widget needs one platform. */
  readonly needsSinglePlatform?: boolean;
};

const BASE: WidgetConfig = { metric: "views", range: 28, platform: "all" };

export const WIDGETS: Record<WidgetType, WidgetDefinition> = {
  metric: {
    title: "Number",
    description: "One total with the change from the previous period.",
    sizes: ["s", "m"],
    settings: ["metric", "range", "platform"],
    defaults: BASE,
  },
  trend: {
    title: "Trend",
    description: "A metric day by day.",
    sizes: ["m", "l", "w", "xl"],
    settings: ["metric", "range", "platform"],
    defaults: BASE,
  },
  split: {
    title: "By platform",
    description: "How each platform contributes to a metric.",
    sizes: ["m", "l", "w"],
    settings: ["metric", "range"],
    defaults: BASE,
  },
  topPosts: {
    title: "Top posts",
    description: "Best posts published in the period.",
    sizes: ["l", "w", "xl"],
    settings: ["metric", "range", "platform"],
    defaults: BASE,
  },
  latestPost: {
    title: "Latest post",
    description: "Your newest post and how it is doing.",
    sizes: ["m", "l"],
    settings: ["platform"],
    defaults: BASE,
  },
  inbox: {
    title: "Inbox",
    description: "Comments waiting for a reply.",
    sizes: ["m", "l", "w"],
    settings: ["platform"],
    defaults: BASE,
  },
  goals: {
    title: "Goals",
    description: "Progress on your goals.",
    sizes: ["m", "l", "w"],
    settings: [],
    defaults: BASE,
  },
  mix: {
    title: "Platform mix",
    description: "Each platform in its own colour.",
    sizes: ["l", "m", "w", "xl"],
    settings: ["chart", "metric", "range"],
    defaults: { ...BASE, range: 7, chart: "lines" },
  },
  platform: {
    title: "Platform",
    description: "Followers and views for one account.",
    sizes: ["s", "m"],
    settings: ["platform", "range"],
    defaults: { ...BASE, platform: "youtube" },
    needsSinglePlatform: true,
  },
};

export const WIDGET_TYPES = Object.keys(WIDGETS) as WidgetType[];

export function isWidgetType(value: unknown): value is WidgetType {
  return typeof value === "string" && value in WIDGETS;
}

export function newWidget(type: WidgetType, id: string, config?: Partial<WidgetConfig>): WidgetInstance {
  const definition = WIDGETS[type];
  return { id, type, size: definition.sizes[0]!, config: { ...definition.defaults, ...config } };
}

/** Repairs anything a stale client or an older layout version could have stored. */
export function sanitizeWidget(widget: WidgetInstance): WidgetInstance | null {
  if (!isWidgetType(widget.type)) return null;
  const definition = WIDGETS[widget.type];
  const size = definition.sizes.includes(widget.size) ? widget.size : definition.sizes[0]!;
  const metric = (DASHBOARD_METRICS as readonly string[]).includes(widget.config.metric)
    ? widget.config.metric
    : definition.defaults.metric;
  const range = (RANGES as readonly number[]).includes(widget.config.range)
    ? widget.config.range
    : definition.defaults.range;
  let platform: PlatformFilter =
    widget.config.platform === "all" || isPlatform(widget.config.platform)
      ? widget.config.platform
      : definition.defaults.platform;
  if (definition.needsSinglePlatform && platform === "all") platform = definition.defaults.platform;
  const chart = definition.settings.includes("chart")
    ? (MIX_CHARTS as readonly string[]).includes(widget.config.chart ?? "")
      ? widget.config.chart
      : definition.defaults.chart
    : undefined;
  return { id: widget.id, type: widget.type, size, config: { metric, range, platform, ...(chart ? { chart } : {}) } };
}

export const DEFAULT_LAYOUT: WidgetInstance[] = [
  { id: "views", type: "metric", size: "s", config: { metric: "views", range: 28, platform: "all" } },
  { id: "engagement", type: "metric", size: "s", config: { metric: "engagement", range: 28, platform: "all" } },
  { id: "trend", type: "trend", size: "l", config: { metric: "views", range: 90, platform: "all" } },
  { id: "inbox", type: "inbox", size: "m", config: { metric: "views", range: 28, platform: "all" } },
  { id: "goals", type: "goals", size: "m", config: { metric: "views", range: 28, platform: "all" } },
  { id: "split", type: "split", size: "l", config: { metric: "views", range: 28, platform: "all" } },
  { id: "followers", type: "metric", size: "s", config: { metric: "followers", range: 28, platform: "all" } },
  { id: "youtube", type: "platform", size: "s", config: { metric: "views", range: 28, platform: "youtube" } },
  { id: "top", type: "topPosts", size: "l", config: { metric: "views", range: 28, platform: "all" } },
  { id: "latest", type: "latestPost", size: "m", config: { metric: "views", range: 28, platform: "all" } },
];

export const MAX_WIDGETS = 40;
