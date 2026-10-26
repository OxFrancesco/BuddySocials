import { Pressable, View } from "react-native";
import type { GoalView } from "../../convex/goals";
import { compact, grouped, shortDay } from "@shared/format";
import { color } from "@/theme";
import { GoalBar } from "./goal-bar";
import { Body, Display, Figure, Label } from "./text";

function stateLabel(goal: GoalView): { text: string; coral: boolean } {
  switch (goal.state) {
    case "done":
      return { text: "Done", coral: false };
    case "ahead":
      return { text: "Ahead", coral: false };
    case "behind":
      return { text: `Behind by ${compact(Math.ceil(goal.expected - goal.value))}`, coral: true };
    case "missed":
      return { text: "Missed", coral: true };
    case "upcoming":
      return { text: `Starts ${shortDay(goal.window.start)}`, coral: false };
  }
}

function windowLabel(goal: GoalView): string {
  const when =
    goal.repeat && goal.period === "week"
      ? "Every week"
      : goal.repeat && goal.period === "month"
        ? "Every month"
        : `${shortDay(goal.window.start)} to ${shortDay(goal.window.end)}`;
  const left = goal.state === "ahead" || goal.state === "behind" ? `${goal.daysLeft}d left` : null;
  const streak = goal.streak >= 2 ? `Streak ${goal.streak}` : null;
  return [when, left, streak].filter(Boolean).join(" · ");
}

export function GoalCard({ goal, onPress, compactCard = false }: { goal: GoalView; onPress?: () => void; compactCard?: boolean }) {
  const state = stateLabel(goal);
  return (
    <Pressable
      testID={`goal-${goal._id}`}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => ({
        padding: compactCard ? 0 : 16,
        borderWidth: compactCard ? 0 : 2,
        borderColor: goal.state === "done" ? color.coral : color.line,
        gap: compactCard ? 6 : 10,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        {compactCard ? (
          <Body numberOfLines={1} style={{ flex: 1, fontSize: 13, lineHeight: 18 }}>
            {goal.title}
          </Body>
        ) : (
          <Display size={18} numberOfLines={2} style={{ flex: 1 }}>
            {goal.title}
          </Display>
        )}
        <Label size={10} tone={state.coral ? "coral" : "fg"}>
          {state.text}
        </Label>
      </View>
      {compactCard ? null : (
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Figure size={28}>{grouped(goal.value)}</Figure>
          <Body tone="dim">/ {grouped(goal.target)}</Body>
        </View>
      )}
      <GoalBar progress={goal.progress} pace={goal.state === "done" ? undefined : goal.elapsedShare} height={compactCard ? 10 : 14} />
      {compactCard ? null : <Label size={10}>{windowLabel(goal)}</Label>}
    </Pressable>
  );
}
