import { useMutation, useQuery } from "convex/react";
import { router } from "expo-router";
import { useState } from "react";
import { FlatList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../../convex/_generated/api";
import type { GoalView } from "../../../convex/goals";
import { useToday, useWide } from "@/lib/hooks";
import { Celebration } from "@/ui/celebration";
import { GoalCard } from "@/ui/goal-card";
import { PlusButton } from "@/ui/plus";
import { Body, Label } from "@/ui/text";
import { color } from "@/theme";

export default function Goals() {
  const insets = useSafeAreaInsets();
  const today = useToday();
  const wide = useWide();
  const data = useQuery(api.goals.list, { today });
  const markCelebrated = useMutation(api.goals.markCelebrated);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const celebrate = data?.goals.find((goal) => goal.celebrate && goal._id !== dismissed) ?? null;

  const open = (goal?: GoalView) => router.push({ pathname: "/goal/[id]", params: { id: goal?._id ?? "new" } });

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <View style={{ paddingTop: insets.top + 12, paddingHorizontal: 16, paddingBottom: data && data.hits > 0 ? 12 : 4 }}>
        {data && data.hits > 0 ? <Label testID="goal-hits">{data.hits} hit</Label> : null}
      </View>
      <FlatList
        key={wide ? "wide" : "narrow"}
        data={data?.goals ?? []}
        numColumns={wide ? 2 : 1}
        columnWrapperStyle={wide ? { gap: 16 } : undefined}
        keyExtractor={(goal) => goal._id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120, gap: 16 }}
        renderItem={({ item }) => (
          <View style={{ flex: 1 }}>
            <GoalCard goal={item} onPress={() => open(item)} />
          </View>
        )}
        ListEmptyComponent={
          data === undefined ? undefined : (
            <Body tone="dim" style={{ paddingTop: 24 }}>
              No goals yet.
            </Body>
          )
        }
      />
      <PlusButton
        testID="add-goal"
        accessibilityLabel="New goal"
        onPress={() => open()}
        style={{ position: "absolute", right: 16, bottom: 16 }}
      />
      <Celebration
        goal={celebrate}
        onDone={() => {
          if (!celebrate) return;
          setDismissed(celebrate._id);
          void markCelebrated({ goalId: celebrate._id, windowStart: celebrate.window.start });
        }}
      />
    </View>
  );
}
