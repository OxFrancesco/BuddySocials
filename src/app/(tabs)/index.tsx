import { useMutation, useQuery } from "convex/react";
import { router } from "expo-router";
import { useState } from "react";
import { RefreshControl, View } from "react-native";
import Animated, { useAnimatedRef } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../../convex/_generated/api";
import { relativeTime } from "@shared/format";
import { useNow } from "@/lib/hooks";
import { Button } from "@/ui/button";
import { PlusButton } from "@/ui/plus";
import { Body, Label } from "@/ui/text";
import { color } from "@/theme";
import { GRID_PAD, WidgetGrid } from "@/widgets/grid";
import { useLayout } from "@/widgets/layout";

export default function Home() {
  const insets = useSafeAreaInsets();
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const [editing, setEditing] = useState(false);
  const layout = useLayout();
  const accounts = useQuery(api.accounts.list, {});
  const syncNow = useMutation(api.accounts.syncNow);
  const loadDemo = useMutation(api.accounts.loadDemo);
  const now = useNow();
  const [refreshing, setRefreshing] = useState(false);

  const lastSync = accounts?.reduce<number | null>(
    (latest, account) => (account.lastSyncedAt && (!latest || account.lastSyncedAt > latest) ? account.lastSyncedAt : latest),
    null,
  );
  const syncing = accounts?.some((account) => account.status === "syncing") ?? false;

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <View
        style={{
          paddingTop: insets.top + 12,
          paddingHorizontal: GRID_PAD,
          paddingBottom: 8,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Label testID="sync-status" style={{ flex: 1 }} numberOfLines={1}>
          {syncing ? "Syncing" : lastSync ? `Updated ${relativeTime(lastSync, now)}` : ""}
        </Label>
        {editing ? (
          <Button testID="done-editing" size="sm" label="Done" onPress={() => setEditing(false)} />
        ) : accounts && accounts.length > 0 ? (
          <Button testID="edit-home" size="sm" variant="outline" label="Edit" onPress={() => setEditing(true)} />
        ) : null}
      </View>

      {accounts !== undefined && accounts.length === 0 ? (
        <View style={{ flex: 1, padding: 24, justifyContent: "center", gap: 20 }}>
          <View style={{ gap: 12, alignItems: "flex-start" }}>
            <Button testID="go-accounts" label="Connect accounts" onPress={() => router.navigate("/accounts")} />
            <Button testID="load-demo" variant="outline" label="Try with demo data" onPress={() => void loadDemo({})} />
          </View>
        </View>
      ) : (
        <Animated.ScrollView
          ref={scrollRef}
          contentContainerStyle={{ paddingBottom: editing ? 96 : 32 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={color.fg}
              colors={[color.coral]}
              progressBackgroundColor={color.bg}
              onRefresh={async () => {
                setRefreshing(true);
                try {
                  await syncNow({});
                } finally {
                  setRefreshing(false);
                }
              }}
            />
          }
        >
          {layout.widgets ? (
            <WidgetGrid
              widgets={layout.widgets}
              editing={editing}
              scrollRef={scrollRef}
              onReorder={layout.replace}
              onRemove={layout.remove}
              onCycleSize={layout.cycleSize}
            />
          ) : null}
          {editing && layout.widgets?.length === 0 ? (
            <View style={{ padding: 24 }}>
              <Body tone="dim">Add a widget to build your home.</Body>
            </View>
          ) : null}
        </Animated.ScrollView>
      )}
      {editing ? (
        <PlusButton
          testID="add-widget"
          accessibilityLabel="Add widget"
          onPress={() => router.push("/add-widget")}
          style={{ position: "absolute", right: GRID_PAD, bottom: GRID_PAD }}
        />
      ) : null}
    </View>
  );
}
