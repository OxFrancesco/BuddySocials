import { Pressable, View } from "react-native";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { color } from "@/theme";
import { PlatformLogo } from "./platform-logo";
import { Body, Label } from "./text";

export type DraftView = FunctionReturnType<typeof api.drafts.list>[number];

/** Shown only once a draft has been sent somewhere; a plain draft needs no word. */
export const DRAFT_STATUS_LABEL: Record<Exclude<DraftView["status"], "draft">, string> = {
  publishing: "Publishing",
  published: "Published",
  partial: "Partly published",
  failed: "Failed",
};

export function DraftRow({ draft, onPress }: { draft: DraftView; onPress: () => void }) {
  const firstLine = draft.text.trim().split("\n")[0] || "Empty draft";
  const platforms = [...new Set(draft.targets.map((target) => target.platform))];
  const status = draft.status === "draft" ? null : DRAFT_STATUS_LABEL[draft.status];
  return (
    <Pressable
      testID={`draft-${draft._id}`}
      accessibilityRole="button"
      accessibilityLabel={status ? `${firstLine}, ${status}` : firstLine}
      onPress={onPress}
      style={({ pressed }) => ({
        gap: 6,
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: color.line,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Body numberOfLines={1} tone={draft.text.trim() ? "fg" : "dim"} style={{ fontSize: 13, lineHeight: 19 }}>
        {firstLine}
      </Body>
      {platforms.length > 0 || status ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {platforms.map((platform) => (
            <PlatformLogo key={platform} platform={platform} size={11} opacity={0.7} />
          ))}
          {status ? (
            <Label testID={`draft-status-${draft._id}`} tone={draft.status === "failed" ? "coral" : "dim"}>
              {status}
            </Label>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}
