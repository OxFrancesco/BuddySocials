import * as Haptics from "expo-haptics";
import { Pressable, ScrollView, View } from "react-native";
import { color, font } from "@/theme";
import { Label } from "./text";

type Option<T extends string | number> = { value: T; label: string };

/** Segmented choice. Active item: coral fill, black text. Others: 2px grey outline. */
export function Chips<T extends string | number>({
  options,
  value,
  onChange,
  scroll = false,
  testIDPrefix,
}: {
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  scroll?: boolean;
  testIDPrefix?: string;
}) {
  const items = options.map((option) => {
    const active = option.value === value;
    return (
      <Pressable
        key={String(option.value)}
        testID={testIDPrefix ? `${testIDPrefix}-${option.value}` : undefined}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        onPress={() => {
          if (active) return;
          void Haptics.selectionAsync();
          onChange(option.value);
        }}
        hitSlop={{ top: 6, bottom: 6 }}
        style={{
          height: 32,
          paddingHorizontal: 12,
          justifyContent: "center",
          borderWidth: 2,
          borderColor: active ? color.coral : color.line,
          backgroundColor: active ? color.coral : "transparent",
        }}
      >
        <Label size={11} tone={active ? "bg" : "fg"} style={{ fontFamily: font.monoBold }}>
          {option.label}
        </Label>
      </Pressable>
    );
  });
  if (scroll) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {items}
      </ScrollView>
    );
  }
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{items}</View>;
}
