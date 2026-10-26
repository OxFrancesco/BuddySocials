import { router, useLocalSearchParams } from "expo-router";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DASHBOARD_METRICS, METRIC_LABEL } from "@shared/metrics";
import { PLATFORMS, PLATFORM_LABEL } from "@shared/platforms";
import { RANGES, WIDGETS, WIDGET_SIZES, type PlatformFilter } from "@shared/widgets";
import { Button } from "@/ui/button";
import { Chips } from "@/ui/chips";
import { Display } from "@/ui/text";
import { color } from "@/theme";
import { useGridCell } from "@/widgets/grid";
import { useLayout } from "@/widgets/layout";
import { Widget, tileSize } from "@/widgets/registry";

export default function EditWidget() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const grid = useGridCell();
  const layout = useLayout();
  const widget = layout.widgets?.find((candidate) => candidate.id === id);
  if (!widget) return <View style={{ flex: 1, backgroundColor: color.bg }} />;

  const definition = WIDGETS[widget.type];
  const set = (change: Partial<typeof widget.config>) =>
    layout.update(widget.id, (current) => ({ ...current, config: { ...current.config, ...change } }));
  const previewWidth = Math.min(width - 32, tileSize(widget, grid).width);
  const scale = previewWidth / tileSize(widget, grid).width;
  const platformOptions: { value: PlatformFilter; label: string }[] = [
    ...(definition.needsSinglePlatform ? [] : [{ value: "all" as const, label: "All" }]),
    ...PLATFORMS.map((platform) => ({ value: platform, label: PLATFORM_LABEL[platform] })),
  ];

  return (
    <ScrollView
      style={{ backgroundColor: color.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 24 }}
    >
      <Display size={24}>{definition.title}</Display>
      <View style={{ alignItems: "flex-start" }} pointerEvents="none">
        <Widget widget={widget} grid={grid} sizeOverride={{ width: previewWidth, height: tileSize(widget, grid).height * scale }} />
      </View>

      {definition.sizes.length > 1 ? (
        <View>
          <Chips
            testIDPrefix="size"
            options={definition.sizes.map((size) => ({ value: size, label: WIDGET_SIZES[size].label }))}
            value={widget.size}
            onChange={(size) => layout.update(widget.id, (current) => ({ ...current, size }))}
          />
        </View>
      ) : null}
      {definition.settings.includes("metric") ? (
        <View>
          <Chips
            testIDPrefix="metric"
            options={DASHBOARD_METRICS.map((metric) => ({ value: metric, label: METRIC_LABEL[metric] }))}
            value={widget.config.metric}
            onChange={(metric) => set({ metric })}
          />
        </View>
      ) : null}
      {definition.settings.includes("range") ? (
        <View>
          <Chips
            testIDPrefix="range"
            options={RANGES.map((range) => ({ value: range, label: `${range} days` }))}
            value={widget.config.range}
            onChange={(range) => set({ range })}
          />
        </View>
      ) : null}
      {definition.settings.includes("platform") ? (
        <View>
          <Chips testIDPrefix="platform" options={platformOptions} value={widget.config.platform} onChange={(platform) => set({ platform })} />
        </View>
      ) : null}

      <View style={{ flexDirection: "row", gap: 12 }}>
        <Button testID="widget-done" label="Done" onPress={() => router.back()} />
        <Button
          testID="widget-remove"
          variant="outline"
          label="Remove"
          onPress={() => {
            layout.remove(widget.id);
            router.back();
          }}
        />
      </View>
    </ScrollView>
  );
}
