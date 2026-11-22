import { Pressable, View } from "react-native";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { color } from "@/theme";
import { PlatformLogo } from "./platform-logo";
import { Body, Label } from "./text";

export type DraftView = FunctionReturnType<typeof api.drafts.list>[number];

/** Shown only once a draft has been scheduled or sent somewhere; a plain draft needs no word. */
export const DRAFT_STATUS_LABEL: Record<Exclude<DraftView["status"], "draft">, string> = {
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  partial: "Partly published",
  failed: "Failed",
};

function formatScheduled(at: number): string {
  const date = new Date(at);
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${month} ${day} ${hh}:${mm}`;
}

export function DraftRow({ draft, onPress }: { draft: DraftView; onPress: () => void }) {
  const heading = draft.title?.trim() || draft.text.trim().split("\n")[0] || "Empty draft";
  const platforms = [...new Set(draft.targets.map((target) => target.platform))];
  const status = draft.status === "draft" ? null : DRAFT_STATUS_LABEL[draft.status];
  const scheduled = draft.scheduledFor ? formatScheduled(draft.scheduledFor) : null;
  const customCount = Object.keys(draft.platformText ?? {}).length;
  return (
    <Pressable
      testID={`draft-${draft._id}`}
      accessibilityRole="button"
      accessibilityLabel={status ? `${heading}, ${status}` : heading}
      onPress={onPress}
      style={({ pressed }) => ({
        gap: 6,
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: color.line,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Body numberOfLines={1} tone={draft.title || draft.text.trim() ? "fg" : "dim"} style={{ fontSize: 13, lineHeight: 19 }}>
        {heading}
      </Body>
      {platforms.length > 0 || status || scheduled || draft.media.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {platforms.map((platform) => (
            <PlatformLogo key={platform} platform={platform} size={11} opacity={0.7} />
          ))}
          {draft.media.length > 0 ? (
            <Label tone="faint">
              {draft.media[0]?.kind === "video" ? "Video" : `${draft.media.length} img`}
            </Label>
          ) : null}
          {customCount > 0 ? <Label tone="faint">{customCount} tailored</Label> : null}
          {scheduled ? <Label tone="coral">{scheduled}</Label> : null}
          {status && !scheduled ? (
            <Label testID={`draft-status-${draft._id}`} tone={draft.status === "failed" ? "coral" : "dim"}>
              {status}
            </Label>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}
