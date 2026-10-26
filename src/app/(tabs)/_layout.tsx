import { useQuery } from "convex/react";
import * as Haptics from "expo-haptics";
import { Tabs, type BottomTabBarProps } from "expo-router/tabs";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../../convex/_generated/api";
import { Label } from "@/ui/text";
import { color } from "@/theme";

const LABELS: Record<string, string> = { index: "Home", posts: "Posts", inbox: "Inbox", goals: "Goals", accounts: "Accounts" };

function TabBar({ state, navigateToTab }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const open = useQuery(api.comments.openSummary, {});
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: color.bg,
        borderTopWidth: 2,
        borderTopColor: color.line,
        paddingBottom: insets.bottom,
      }}
    >
      {state.routes.map((route, index) => {
        const active = state.index === index;
        const count = route.name === "inbox" && open && open.count > 0 ? (open.count >= 100 ? "99+" : String(open.count)) : null;
        return (
          <Pressable
            key={route.key}
            testID={`tab-${route.name}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={count ? `${LABELS[route.name]}, ${count} waiting` : LABELS[route.name]}
            onPress={() => {
              if (active) return;
              void Haptics.selectionAsync();
              navigateToTab(route.key);
            }}
            style={{ flex: 1, height: 56, alignItems: "center", justifyContent: "center", backgroundColor: active ? color.coral : color.bg }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Label size={11} tone={active ? "bg" : "fg"}>
                {LABELS[route.name]}
              </Label>
              {count ? (
                <Label size={10} tone={active ? "bg" : "coral"}>
                  {count}
                </Label>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false, animation: "none", sceneStyle: { backgroundColor: color.bg } }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="posts" />
      <Tabs.Screen name="inbox" />
      <Tabs.Screen name="goals" />
      <Tabs.Screen name="accounts" />
    </Tabs>
  );
}
