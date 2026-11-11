import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { PLATFORMS, PLATFORM_LABEL, type Platform } from "@shared/platforms";
import { color, font } from "@/theme";
import { PlatformLogo } from "./platform-logo";
import { Label } from "./text";

/** With an icon, the chip shows only the icon and the label becomes its accessible name. */
type Option<T extends string | number> = { value: T; label: string; icon?: (tint: string) => ReactNode };

/** "All" plus one logo chip per platform. */
export function platformOptions(withAll: false): Option<Platform>[];
export function platformOptions(withAll?: true): Option<Platform | "all">[];
export function platformOptions(withAll = true): Option<Platform | "all">[] {
  const logos = PLATFORMS.map((platform) => ({
    value: platform,
    label: PLATFORM_LABEL[platform],
    icon: (tint: string) => <PlatformLogo platform={platform} size={14} tint={tint} />,
  }));
  return withAll ? [{ value: "all", label: "All" }, ...logos] : logos;
}

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
        accessibilityLabel={option.label}
        onPress={() => {
          if (active) return;
          void Haptics.selectionAsync();
          onChange(option.value);
        }}
        hitSlop={{ top: 6, bottom: 6 }}
        style={{
          height: 32,
          paddingHorizontal: option.icon ? 10 : 12,
          justifyContent: "center",
          borderWidth: 2,
          borderColor: active ? color.coral : color.line,
          backgroundColor: active ? color.coral : "transparent",
        }}
      >
        {option.icon ? (
          option.icon(active ? color.bg : color.fg)
        ) : (
          <Label size={11} tone={active ? "bg" : "fg"} style={{ fontFamily: font.monoBold }}>
            {option.label}
          </Label>
        )}
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
