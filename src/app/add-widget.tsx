import { router } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MIX_CHARTS, MIX_CHART_LABEL, WIDGET_TYPES, WIDGETS, newWidget, type WidgetConfig, type WidgetType } from "@shared/widgets";
import { Button } from "@/ui/button";
import { PlusGlyph } from "@/ui/plus";
import { Display, Label } from "@/ui/text";
import { color } from "@/theme";
import { GRID_PAD, useGridCell } from "@/widgets/grid";
import { useLayout } from "@/widgets/layout";
import { Widget, tileSize } from "@/widgets/registry";

const CORNER = 32;

/** Gallery entries: one per widget type, and one per chart for the platform mix. */
type Entry = { key: string; type: WidgetType; config?: Partial<WidgetConfig> };
const ENTRIES: Entry[] = WIDGET_TYPES.flatMap((type): Entry[] =>
  type === "mix" ? MIX_CHARTS.map((chart) => ({ key: `mix-${chart}`, type, config: { chart } })) : [{ key: type, type }],
);

/**
 * Every widget type, live, at the size it will land on home, on the same grid.
 * Tapping a preview adds it to the end of the home layout.
 */
export default function AddWidget() {
  const insets = useSafeAreaInsets();
  const grid = useGridCell();
  const layout = useLayout();

  return (
    <ScrollView
      style={{ backgroundColor: color.bg }}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, paddingHorizontal: GRID_PAD, gap: 20 }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Display size={24}>Add widget</Display>
        <Button testID="close-gallery" size="sm" variant="outline" label="Close" onPress={() => router.back()} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: grid.gap, rowGap: 20 }}>
        {ENTRIES.map(({ key, type, config }) => {
          const sample = newWidget(type, `preview-${key}`, config);
          const size = tileSize(sample, grid);
          return (
            <Pressable
              key={key}
              testID={`add-${key}`}
              accessibilityRole="button"
              accessibilityLabel={`Add ${WIDGETS[type].title}`}
              onPress={() => {
                layout.add(type, config);
                router.back();
              }}
              style={({ pressed }) => ({ width: size.width, gap: 8, opacity: pressed ? 0.6 : 1 })}
            >
              <Label size={11} tone="fg">
                {WIDGETS[type].title}
                {config?.chart ? ` · ${MIX_CHART_LABEL[config.chart]}` : ""}
              </Label>
              <View pointerEvents="none">
                <Widget widget={sample} grid={grid} />
                <View
                  style={{
                    position: "absolute",
                    right: 0,
                    bottom: 0,
                    width: CORNER,
                    height: CORNER,
                    backgroundColor: color.coral,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <PlusGlyph size={14} thickness={3} />
                </View>
              </View>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}
