import * as Haptics from "expo-haptics";
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated from "react-native-reanimated";
import { color, font, motion } from "@/theme";

type Variant = "default" | "primary" | "outline" | "ghost";

type Props = {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  size?: "default" | "sm";
  disabled?: boolean;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
};

const SHADOW = 4;

/**
 * The site's whole language in one control: a 3px outline over a hard 4px
 * shadow. Pressing sinks the face onto the shadow; no spring, no bounce.
 */
export function Button({ label, onPress, variant = "default", size = "default", disabled, icon, style, testID, accessibilityLabel }: Props) {
  const [pressed, setPressed] = useState(false);
  const raised = variant === "default" || variant === "primary";
  const height = size === "sm" ? 36 : 44;
  const fill = variant === "primary" ? color.coral : variant === "ghost" ? "transparent" : color.bg;
  const ink = variant === "primary" ? color.bg : color.fg;
  const border = variant === "primary" ? color.coral : variant === "ghost" ? "transparent" : pressed && !raised ? color.coral : color.fg;
  const shift = raised && pressed ? SHADOW : 0;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress?.();
      }}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      hitSlop={size === "sm" ? 6 : 2}
      style={[{ opacity: disabled ? 0.6 : 1, paddingRight: raised ? SHADOW : 0, paddingBottom: raised ? SHADOW : 0 }, style]}
    >
      {raised ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { top: SHADOW, left: SHADOW, backgroundColor: color.fg }]}
        />
      ) : null}
      <Animated.View
        style={{
          height,
          paddingHorizontal: size === "sm" ? 12 : 18,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          backgroundColor: fill,
          borderWidth: variant === "ghost" ? 0 : 3,
          borderColor: border,
          transform: [{ translateX: shift }, { translateY: shift }],
          transitionProperty: ["transform", "borderColor"],
          transitionDuration: motion.press,
          transitionTimingFunction: "ease-out",
        }}
      >
        {icon}
        <Animated.Text
          numberOfLines={1}
          style={{
            fontFamily: font.monoBold,
            fontSize: size === "sm" ? 11 : 12,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: ink,
          }}
        >
          {label}
        </Animated.Text>
      </Animated.View>
    </Pressable>
  );
}
