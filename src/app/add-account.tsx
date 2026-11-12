import { useQuery } from "convex/react";
import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../convex/_generated/api";
import { PLATFORMS, PLATFORM_LABEL } from "@shared/platforms";
import { useConnect } from "@/lib/connect";
import { PlatformLogo } from "@/ui/platform-logo";
import { Display, Label } from "@/ui/text";
import { color } from "@/theme";

/** One row per platform the server can sign in to. Tapping opens that platform's sign-in, then closes the sheet. */
export default function AddAccount() {
  const insets = useSafeAreaInsets();
  const available = useQuery(api.connectStore.availability, {});
  const { connect, busy } = useConnect();
  const platforms = PLATFORMS.filter((platform) => available?.[platform] === true);

  return (
    <View style={{ backgroundColor: color.bg, borderTopWidth: 3, borderTopColor: color.fg, paddingTop: 16, paddingHorizontal: 16, paddingBottom: insets.bottom + 16 }}>
      {platforms.map((platform) => (
        <Pressable
          key={platform}
          testID={`add-account-${platform}`}
          accessibilityRole="button"
          accessibilityLabel={`Add a ${PLATFORM_LABEL[platform]} account`}
          disabled={busy !== null}
          onPress={() => {
            void connect(platform, "add").then((finished) => {
              if (finished) router.back();
            });
          }}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 14,
            height: 60,
            borderBottomWidth: 1,
            borderBottomColor: color.line,
            opacity: pressed || (busy !== null && busy !== platform) ? 0.6 : 1,
          })}
        >
          <PlatformLogo platform={platform} size={22} />
          <Display size={20} style={{ flex: 1 }}>
            {PLATFORM_LABEL[platform]}
          </Display>
          {busy === platform ? <Label tone="coral">Opening</Label> : null}
        </Pressable>
      ))}
    </View>
  );
}
