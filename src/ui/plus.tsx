import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated from "react-native-reanimated";
import { color, motion } from "@/theme";

/** A "+" drawn with two bars so it stays crisp at any size, independent of font glyphs. */
export function PlusGlyph({ size, thickness = 3, tint = color.bg }: { size: number; thickness?: number; tint?: string }) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View style={{ position: "absolute", width: size, height: thickness, backgroundColor: tint }} />
      <View style={{ position: "absolute", width: thickness, height: size, backgroundColor: tint }} />
    </View>
  );
}

/** Coral square with a hard white shadow; sinks onto the shadow when pressed. */
export function PlusButton({
  onPress,
  size = 56,
  style,
  testID,
  accessibilityLabel,
}: {
  onPress: () => void;
  size?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel: string;
}) {
  const [pressed, setPressed] = useState(false);
  const shadow = size >= 48 ? 4 : 3;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      hitSlop={8}
      style={[{ width: size + shadow, height: size + shadow }, style]}
    >
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { top: shadow, left: shadow, backgroundColor: color.fg }]} />
      <Animated.View
        style={{
          width: size,
          height: size,
          backgroundColor: color.coral,
          alignItems: "center",
          justifyContent: "center",
          transform: [{ translateX: pressed ? shadow : 0 }, { translateY: pressed ? shadow : 0 }],
          transitionProperty: "transform",
          transitionDuration: motion.press,
          transitionTimingFunction: "ease-out",
        }}
      >
        <PlusGlyph size={Math.round(size * 0.42)} thickness={size >= 48 ? 4 : 3} />
      </Animated.View>
    </Pressable>
  );
}
