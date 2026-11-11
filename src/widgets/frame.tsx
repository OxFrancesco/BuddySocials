import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import type { Platform } from "@shared/platforms";
import { PlatformLogo } from "@/ui/platform-logo";
import { Label } from "@/ui/text";
import { color } from "@/theme";

export const TILE_PAD = 16;

/**
 * A widget at rest is quiet: a 2px grey outline on black. In edit mode the
 * grid swaps in a white 3px outline with a hard shadow, so tiles read as
 * blocks you can pick up.
 */
export function Frame({
  title,
  platform,
  children,
  onPress,
  width,
  height,
  testID,
}: {
  title: string;
  platform?: Platform;
  children: ReactNode;
  onPress?: () => void;
  width: number;
  height: number;
  testID?: string;
}) {
  const body = (
    <View style={{ width, height, padding: TILE_PAD, borderWidth: 2, borderColor: color.line, backgroundColor: color.bg, gap: 10, overflow: "hidden" }}>
      {platform ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <PlatformLogo platform={platform} size={11} opacity={0.7} />
          <Label numberOfLines={1} style={{ flexShrink: 1 }}>
            {title}
          </Label>
        </View>
      ) : (
        <Label numberOfLines={1}>{title}</Label>
      )}
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
  if (!onPress) return <View testID={testID}>{body}</View>;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
    >
      {body}
    </Pressable>
  );
}

/** Shown when a widget has nothing to say yet, instead of a zero. */
export function Empty({ text = "No data yet" }: { text?: string }) {
  return (
    <View style={{ flex: 1, justifyContent: "flex-end" }}>
      <Label tone="faint">{text}</Label>
    </View>
  );
}

export function Loading() {
  return <View style={{ flex: 1, backgroundColor: color.line, opacity: 0.4 }} />;
}

/** Charts take an explicit height; this measures the space they get. */
export function Measured({ children }: { children: (size: { width: number; height: number }) => ReactNode }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  return (
    <View
      style={{ flex: 1 }}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        if (!size || Math.abs(size.width - width) > 1 || Math.abs(size.height - height) > 1) setSize({ width, height });
      }}
    >
      {size && size.height > 8 ? children(size) : null}
    </View>
  );
}
