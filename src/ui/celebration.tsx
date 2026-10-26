import * as Haptics from "expo-haptics";
import { useEffect } from "react";
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { DitherGradient } from "react-native-dither-kit";
import Animated, { FadeIn, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { GoalView } from "../../convex/goals";
import { grouped } from "@shared/format";
import { color, motion } from "@/theme";
import { Display, Figure, Label } from "./text";

/**
 * Plays once when a goal is hit: a coral dither field rises from the bottom
 * and the goal lands on top of it. The rare-moment budget, spent once.
 */
export function Celebration({ goal, onDone }: { goal: GoalView | null; onDone: () => void }) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const rise = useSharedValue(0);

  useEffect(() => {
    if (!goal) return;
    rise.set(0);
    rise.set(withTiming(1, { duration: reduced ? 0 : 650, easing: motion.easeOut }));
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [goal?._id, reduced, rise]);

  const field = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - rise.get()) * height * 0.6 }] }));

  if (!goal) return null;
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={onDone}>
      <Pressable testID="celebration" style={{ flex: 1 }} onPress={onDone} accessibilityLabel="Goal hit, tap to close">
        <Animated.View entering={reduced ? undefined : FadeIn.duration(200)} style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.92)" }]} />
        <Animated.View style={[{ position: "absolute", left: 0, right: 0, bottom: 0, height: height * 0.6 }, field]}>
          <DitherGradient from={color.coral} to="transparent" direction="up" cell={4} style={{ flex: 1 }} />
        </Animated.View>
        <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 28, paddingBottom: insets.bottom + 120, gap: 14 }}>
          <Label size={12} tone="coral">
            Goal hit
          </Label>
          <Display size={40}>{goal.title}</Display>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
            <Figure size={30}>{grouped(goal.value)}</Figure>
            {goal.streak >= 1 ? <Label size={11} tone="fg">Streak {goal.streak + 1}</Label> : null}
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}
