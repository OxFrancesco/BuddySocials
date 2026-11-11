import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { View } from "react-native";
import { api } from "../../convex/_generated/api";
import { bytesLabel } from "@shared/format";
import { Button } from "./button";
import { Chips } from "./chips";
import { Body, Label } from "./text";

/** Unused uploads: when they are deleted, how much is waiting, and a button to delete them now. */
export function CleanupBar() {
  const cleanup = useQuery(api.media.cleanup, {});
  const setCleanup = useMutation(api.media.setCleanup);
  const cleanupNow = useMutation(api.media.cleanupNow);
  const [busy, setBusy] = useState(false);
  if (!cleanup) return null;

  const options = [...cleanup.options.map((days) => ({ value: days, label: days === 1 ? "1 day" : `${days} days` })), { value: 0, label: "By hand" }];
  const waiting =
    cleanup.files === 0
      ? "No unused files."
      : `${cleanup.files}${cleanup.more ? "+" : ""} unused ${cleanup.files === 1 ? "file" : "files"}, ${bytesLabel(cleanup.bytes)}.`;

  return (
    <View testID="cleanup-bar" style={{ gap: 10, paddingTop: 32 }}>
      <Label>Delete unused images and videos after</Label>
      <Chips
        testIDPrefix="cleanup-after"
        options={options}
        value={cleanup.afterDays ?? 0}
        onChange={(days) => void setCleanup({ afterDays: days === 0 ? null : days })}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Body testID="cleanup-waiting" tone="dim" style={{ flex: 1 }}>
          {waiting}
        </Body>
        {cleanup.files > 0 ? (
          <Button
            testID="cleanup-now"
            size="sm"
            variant="outline"
            label="Delete now"
            disabled={busy}
            onPress={() => {
              setBusy(true);
              void cleanupNow({}).finally(() => setBusy(false));
            }}
          />
        ) : null}
      </View>
    </View>
  );
}
