import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useMemo } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import Animated, { type AnimatedRef } from "react-native-reanimated";
import Sortable from "react-native-sortables";
import { WIDGETS, WIDGET_SIZES, type WidgetInstance } from "@shared/widgets";
import { Label } from "@/ui/text";
import { WIDE, color } from "@/theme";
import { Widget, tileSize, type Cell } from "./registry";

export const GRID_PAD = 16;

export function useGridCell(): Cell {
  const { width } = useWindowDimensions();
  return useMemo(() => {
    const cols = width >= WIDE ? 4 : 2;
    const gap = width >= WIDE ? 16 : 12;
    const cell = Math.floor((width - GRID_PAD * 2 - gap * (cols - 1)) / cols);
    const rowHeight = Math.round(Math.min(Math.max(cell * 0.9, 136), 210));
    return { cell, rowHeight, gap, cols };
  }, [width]);
}

const SIZE_TAG = { s: "S", m: "M", l: "L", w: "W", xl: "XL" } as const;

function TileButton({ label, onTap, testID, accessibilityLabel }: { label: string; onTap: () => void; testID: string; accessibilityLabel?: string }) {
  return (
    <Sortable.Touchable
      onTap={() => {
        void Haptics.selectionAsync();
        onTap();
      }}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={{ minWidth: 32, height: 32, paddingHorizontal: 8, alignItems: "center", justifyContent: "center", backgroundColor: color.fg }}
    >
      <Label size={10} tone="bg">
        {label}
      </Label>
    </Sortable.Touchable>
  );
}

export function WidgetGrid({
  widgets,
  editing,
  scrollRef,
  onReorder,
  onRemove,
  onCycleSize,
}: {
  widgets: WidgetInstance[];
  editing: boolean;
  scrollRef: AnimatedRef<Animated.ScrollView>;
  onReorder: (next: WidgetInstance[]) => void;
  onRemove: (id: string) => void;
  onCycleSize: (id: string) => void;
}) {
  const grid = useGridCell();

  return (
    <Sortable.Flex
      gap={grid.gap}
      padding={GRID_PAD}
      sortEnabled={editing}
      scrollableRef={scrollRef}
      dragActivationDelay={150}
      activeItemScale={1.02}
      inactiveItemOpacity={0.6}
      onDragStart={() => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
      onDragEnd={({ order }) => onReorder(order(widgets))}
    >
      {widgets.map((widget) => {
        const size = tileSize(widget, grid);
        const resizable = WIDGETS[widget.type].sizes.length > 1;
        return (
          <View key={widget.id} style={{ width: size.width, height: size.height }}>
            <View pointerEvents={editing ? "none" : "auto"} style={{ opacity: editing ? 0.4 : 1 }}>
              <Widget widget={widget} grid={grid} />
            </View>
            {editing ? (
              <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
                <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderWidth: 3, borderColor: color.fg }]} />
                <View style={{ position: "absolute", left: 10, right: 10, bottom: 10, flexDirection: "row", justifyContent: "space-between" }}>
                  {resizable ? (
                    <TileButton
                      testID={`resize-${widget.id}`}
                      label={SIZE_TAG[widget.size]}
                      accessibilityLabel={`Size ${WIDGET_SIZES[widget.size].label}, tap to change`}
                      onTap={() => onCycleSize(widget.id)}
                    />
                  ) : (
                    <View />
                  )}
                  <View style={{ flexDirection: "row", gap: 6 }}>
                    <TileButton
                      testID={`edit-${widget.id}`}
                      label="Edit"
                      onTap={() => router.push({ pathname: "/widget/[id]", params: { id: widget.id } })}
                    />
                    <TileButton testID={`remove-${widget.id}`} label="×" accessibilityLabel="Remove widget" onTap={() => onRemove(widget.id)} />
                  </View>
                </View>
              </View>
            ) : null}
          </View>
        );
      })}
    </Sortable.Flex>
  );
}
