import { useEffect } from "react";
import { View } from "react-native";
import { DitherGradient } from "react-native-dither-kit";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { color, motion } from "@/theme";

/**
 * Progress inside a 2px outline. The fill is coral with a dithered leading
 * edge; a white tick marks where the pace says you should be by now.
 */
export function GoalBar({ progress, pace, height = 14 }: { progress: number; pace?: number; height?: number }) {
  const reduced = useReducedMotion();
  const share = Math.max(0, Math.min(1, progress));
  const fill = useSharedValue(reduced ? share : 0);

  useEffect(() => {
    fill.set(reduced ? share : withTiming(share, { duration: 700, easing: motion.easeOut }));
  }, [fill, reduced, share]);

  const style = useAnimatedStyle(() => ({ width: `${fill.get() * 100}%` }));

  return (
    <View style={{ height, borderWidth: 2, borderColor: color.line, overflow: "hidden" }}>
      <Animated.View style={[{ position: "absolute", top: 0, bottom: 0, left: 0, flexDirection: "row" }, style]}>
        <View style={{ flex: 1, backgroundColor: color.coral }} />
        {share < 1 ? (
          <DitherGradient from={color.coral} to="transparent" direction="right" cell={2} style={{ width: 18, height: "100%" }} />
        ) : null}
      </Animated.View>
      {pace !== undefined && pace > 0 && pace < 1 ? (
        <View style={{ position: "absolute", top: 0, bottom: 0, left: `${pace * 100}%`, width: 2, backgroundColor: color.fg }} />
      ) : null}
    </View>
  );
}
