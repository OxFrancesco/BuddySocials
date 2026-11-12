import { useMutation, useQuery } from "convex/react";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { addDays } from "@shared/format";
import { GOAL_METRICS, GOAL_METRIC_LABEL, goalTitle, monthOf, weekOf, type GoalMetric } from "@shared/goals";
import type { Platform } from "@shared/platforms";
import { useToday } from "@/lib/hooks";
import { Button } from "@/ui/button";
import { Chips, platformOptions } from "@/ui/chips";
import { Body, Display } from "@/ui/text";
import { color, font } from "@/theme";

type When = "week" | "month" | "next7" | "next30" | "keep";

export default function GoalEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const insets = useSafeAreaInsets();
  const today = useToday();
  const data = useQuery(api.goals.list, { today });
  const existing = isNew ? undefined : data?.goals.find((goal) => goal._id === id);
  const create = useMutation(api.goals.create);
  const update = useMutation(api.goals.update);
  const remove = useMutation(api.goals.remove);

  const [metric, setMetric] = useState<GoalMetric>("views");
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [target, setTarget] = useState("");
  const [when, setWhen] = useState<When>("week");
  const [repeat, setRepeat] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(isNew);

  useEffect(() => {
    if (loaded || !existing) return;
    setMetric(existing.metric);
    setPlatform(existing.platform);
    setTarget(String(existing.target));
    setWhen(existing.period === "range" ? "keep" : existing.period);
    setRepeat(existing.repeat);
    setLoaded(true);
  }, [existing, loaded]);

  const amount = Number(target.replace(/[^\d]/g, ""));
  const preview = amount > 0 ? goalTitle({ metric, platform, target: amount }) : GOAL_METRIC_LABEL[metric];

  function window(): { period: "week" | "month" | "range"; startDay: string; endDay: string; repeat: boolean } {
    switch (when) {
      case "week": {
        const range = weekOf(today);
        return { period: "week", startDay: range.start, endDay: range.end, repeat };
      }
      case "month": {
        const range = monthOf(today);
        return { period: "month", startDay: range.start, endDay: range.end, repeat };
      }
      case "next7":
        return { period: "range", startDay: today, endDay: addDays(today, 6), repeat: false };
      case "next30":
        return { period: "range", startDay: today, endDay: addDays(today, 29), repeat: false };
      case "keep":
        return { period: "range", startDay: existing!.startDay, endDay: existing!.endDay, repeat: false };
    }
  }

  async function save() {
    setError(null);
    try {
      const fields = { metric, platform, target: amount, ...window() };
      if (isNew) await create(fields);
      else await update({ goalId: id as Id<"goals">, ...fields });
      router.back();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^.*Uncaught Error: /, "").split("\n")[0]! : "Could not save.");
    }
  }

  const whenOptions: { value: When; label: string }[] = [
    { value: "week", label: "This week" },
    { value: "month", label: "This month" },
    { value: "next7", label: "Next 7 days" },
    { value: "next30", label: "Next 30 days" },
    ...(existing?.period === "range" ? [{ value: "keep" as When, label: "Current dates" }] : []),
  ];

  return (
    <KeyboardAwareScrollView
      style={{ backgroundColor: color.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32, paddingHorizontal: 16, gap: 24 }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <Display testID="goal-preview" size={28} style={{ flex: 1 }}>
          {preview}
        </Display>
        <Button testID="close-goal" size="sm" variant="outline" label="Close" onPress={() => router.back()} />
      </View>

      <TextInput
        testID="goal-target"
        value={target}
        onChangeText={(text) => setTarget(text.replace(/[^\d]/g, "").slice(0, 12))}
        placeholder="Target"
        placeholderTextColor="rgba(255,255,255,0.6)"
        keyboardType="number-pad"
        style={{ fontFamily: font.mono, fontSize: 40, color: color.fg, borderBottomWidth: 3, borderBottomColor: amount > 0 ? color.coral : color.line, paddingVertical: 6 }}
      />

      <Chips
        testIDPrefix="goal-metric"
        options={GOAL_METRICS.map((value) => ({ value, label: GOAL_METRIC_LABEL[value] }))}
        value={metric}
        onChange={setMetric}
      />
      <Chips
        testIDPrefix="goal-platform"
        options={platformOptions()}
        value={platform}
        onChange={setPlatform}
      />
      <Chips testIDPrefix="goal-when" options={whenOptions} value={when} onChange={setWhen} />
      {when === "week" || when === "month" ? (
        <Chips
          testIDPrefix="goal-repeat"
          options={[
            { value: "repeat", label: when === "week" ? "Every week" : "Every month" },
            { value: "once", label: "Just this one" },
          ]}
          value={repeat ? "repeat" : "once"}
          onChange={(value) => setRepeat(value === "repeat")}
        />
      ) : null}

      {error ? <Body tone="coral">{error}</Body> : null}
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Button testID="save-goal" variant="primary" label={isNew ? "Set goal" : "Save"} disabled={amount <= 0} onPress={() => void save()} />
        {isNew ? null : (
          <Button
            testID="delete-goal"
            variant="outline"
            label="Delete"
            onPress={() => {
              void remove({ goalId: id as Id<"goals"> });
              router.back();
            }}
          />
        )}
      </View>
    </KeyboardAwareScrollView>
  );
}
