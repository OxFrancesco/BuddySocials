import { useQuery } from "convex/react";
import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../convex/_generated/api";
import { PLATFORMS, PLATFORM_LABEL, type Platform } from "@shared/platforms";
import { useConnect } from "@/lib/connect";
import { PlatformLogo } from "@/ui/platform-logo";
import { Display, Label } from "@/ui/text";
import { color } from "@/theme";

type Row = { key: string; platform: Platform; label: string; pages: boolean };

/** One row per platform the server can sign in to. Tapping opens that platform's sign-in, then closes the sheet. */
export default function AddAccount() {
  const insets = useSafeAreaInsets();
  const available = useQuery(api.connectStore.availability, {});
  const pagesAvailable = useQuery(api.connectStore.pagesAvailable, {}) === true;
  const { connect, busy } = useConnect();
  const rows: Row[] = PLATFORMS.filter((platform) => available?.[platform] === true).map((platform) => ({
    key: platform,
    platform,
    label: PLATFORM_LABEL[platform],
    pages: false,
  }));
  // Company Pages you administer, signed in through LinkedIn's separate Pages app.
  if (pagesAvailable) rows.push({ key: "linkedin-pages", platform: "linkedin", label: "LinkedIn Page", pages: true });

  return (
    <View style={{ backgroundColor: color.bg, borderTopWidth: 3, borderTopColor: color.fg, paddingTop: 16, paddingHorizontal: 16, paddingBottom: insets.bottom + 16 }}>
      {rows.map((row) => (
        <Pressable
          key={row.key}
          testID={`add-account-${row.key}`}
          accessibilityRole="button"
          accessibilityLabel={row.pages ? "Add a LinkedIn Page you administer" : `Add a ${row.label} account`}
          disabled={busy !== null}
          onPress={() => {
            void connect(row.platform, "add", { pages: row.pages }).then((finished) => {
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
            opacity: pressed || (busy !== null && busy !== row.platform) ? 0.6 : 1,
          })}
        >
          <PlatformLogo platform={row.platform} size={22} />
          <Display size={20} style={{ flex: 1 }}>
            {row.label}
          </Display>
          {busy === row.platform ? <Label tone="coral">Opening</Label> : null}
        </Pressable>
      ))}
    </View>
  );
}
