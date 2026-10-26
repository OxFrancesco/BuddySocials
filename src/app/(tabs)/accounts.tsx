import { useClerk, useUser } from "@clerk/expo";
import { useAction, useMutation, useQuery } from "convex/react";
import * as Linking from "expo-linking";
import { useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { Platform as RNPlatform, ScrollView, View } from "react-native";
import { requestPinWidget } from "react-native-android-widget";
import { HOME_WIDGETS } from "@/home-widgets/task-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../../convex/_generated/api";
import { compact, relativeTime } from "@shared/format";
import { PLATFORMS, PLATFORM_LABEL, isPlatform, type Platform } from "@shared/platforms";
import { useNow } from "@/lib/hooks";
import { Button } from "@/ui/button";
import { Body, Display, Label } from "@/ui/text";
import { color } from "@/theme";

export default function Accounts() {
  const insets = useSafeAreaInsets();
  const now = useNow();
  const params = useLocalSearchParams<{ connected?: string; error?: string }>();
  const accounts = useQuery(api.accounts.list, {});
  const available = useQuery(api.connectStore.availability, {});
  const begin = useAction(api.connect.begin);
  const syncNow = useMutation(api.accounts.syncNow);
  const disconnect = useMutation(api.connectStore.disconnect);
  const loadDemo = useMutation(api.accounts.loadDemo);
  const removeDemo = useMutation(api.accounts.removeDemo);
  const { signOut } = useClerk();
  const { user } = useUser();
  const [busy, setBusy] = useState<Platform | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    if (params.connected && isPlatform(params.connected)) setNotice({ text: `${PLATFORM_LABEL[params.connected]} connected.`, error: false });
    else if (params.error) setNotice({ text: params.error, error: true });
  }, [params.connected, params.error]);

  async function connect(platform: Platform) {
    setBusy(platform);
    setNotice(null);
    try {
      const url = await begin({ platform });
      const result = await WebBrowser.openAuthSessionAsync(url, "buddysocials://accounts");
      if (result.type === "success") {
        const { queryParams } = Linking.parse(result.url);
        const error = typeof queryParams?.error === "string" ? queryParams.error : null;
        setNotice(error ? { text: error, error: true } : { text: `${PLATFORM_LABEL[platform]} connected.`, error: false });
      }
    } catch (cause) {
      setNotice({ text: cause instanceof Error ? cause.message.split("\n")[0]!.replace(/^.*Uncaught Error: /, "") : "Could not start sign-in.", error: true });
    } finally {
      setBusy(null);
    }
  }

  const hasDemo = accounts?.some((account) => account.source === "demo") ?? false;
  const missing = PLATFORMS.filter((platform) => !accounts?.some((account) => account.platform === platform));

  return (
    <ScrollView
      style={{ backgroundColor: color.bg }}
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 16, paddingBottom: 40, gap: 4 }}
    >
      {notice ? (
        <View style={{ borderWidth: 2, borderColor: notice.error ? color.coral : color.fg, padding: 12, marginBottom: 12 }}>
          <Body tone={notice.error ? "coral" : "fg"}>{notice.text}</Body>
        </View>
      ) : null}

      {PLATFORMS.map((platform) => {
        const account = accounts?.find((candidate) => candidate.platform === platform);
        const canConnect = available?.[platform] === true;
        let status = "Not connected";
        if (account) {
          if (account.status === "syncing") status = "Syncing";
          else if (account.status === "reconnect") status = "Sign in again";
          else if (account.status === "error") status = account.lastError ?? "Sync failed";
          else if (account.limited?.length) status = `No access to ${account.limited.join(", ")}`;
          else status = account.source === "demo" ? "Demo data" : "Connected";
        }
        const details = account
          ? [
              account.source === "direct" ? account.handle : null,
              account.followers ? `${compact(account.followers)} followers` : null,
              account.lastSyncedAt ? `updated ${relativeTime(account.lastSyncedAt, now)}` : null,
            ].filter(Boolean)
          : [];
        return (
          <View key={platform} testID={`account-${platform}`} style={{ paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: color.line, gap: 12 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <Display size={20}>{PLATFORM_LABEL[platform]}</Display>
                <Label size={10} tone={account?.status === "error" || account?.status === "reconnect" ? "coral" : "dim"}>
                  {status}
                </Label>
                {details.length > 0 ? <Label size={10}>{details.join(" · ")}</Label> : null}
              </View>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {(!account || account.source === "demo" || account.status === "reconnect") && canConnect ? (
                <Button
                  testID={`connect-${platform}`}
                  size="sm"
                  label={busy === platform ? "Opening" : account?.status === "reconnect" ? "Sign in again" : "Connect"}
                  disabled={busy !== null}
                  onPress={() => void connect(platform)}
                />
              ) : null}
              {account && account.source === "direct" ? (
                <>
                  <Button testID={`sync-${platform}`} size="sm" variant="outline" label="Sync" onPress={() => void syncNow({ accountId: account._id })} />
                  <Button size="sm" variant="ghost" label="Disconnect" onPress={() => void disconnect({ accountId: account._id })} />
                </>
              ) : null}
            </View>
          </View>
        );
      })}

      {RNPlatform.OS === "android" ? (
        <View style={{ paddingTop: 24, gap: 10 }}>
          <Label>Home screen</Label>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {HOME_WIDGETS.map((name) => (
              <Button
                key={name}
                testID={`pin-${name}`}
                size="sm"
                variant="outline"
                label={name === "LatestPost" ? "Latest post" : name === "Mix" ? "Platform mix" : name}
                accessibilityLabel={`Add ${name === "LatestPost" ? "Latest post" : name} widget to the home screen`}
                onPress={() =>
                  void requestPinWidget({ widgetName: name }).then((shown) => {
                    if (!shown) setNotice({ text: "This launcher can't add widgets from apps. Long-press the home screen instead.", error: true });
                  })
                }
              />
            ))}
          </View>
        </View>
      ) : null}

      <View style={{ paddingTop: 24, gap: 12, alignItems: "flex-start" }}>
        {hasDemo ? (
          <Button testID="remove-demo" variant="outline" label="Remove demo data" onPress={() => void removeDemo({})} />
        ) : missing.length > 0 ? (
          <Button testID="load-demo-accounts" variant="outline" label="Fill empty platforms with demo data" onPress={() => void loadDemo({})} />
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Button testID="sign-out" variant="ghost" label="Sign out" onPress={() => void signOut()} />
          {user?.primaryEmailAddress ? <Label size={10}>{user.primaryEmailAddress.emailAddress}</Label> : null}
        </View>
      </View>
    </ScrollView>
  );
}
