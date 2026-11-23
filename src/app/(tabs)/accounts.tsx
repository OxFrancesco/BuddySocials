import { useClerk, useUser } from "@clerk/expo";
import { useMutation, useQuery } from "convex/react";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Platform as RNPlatform, ScrollView, View } from "react-native";
import { requestPinWidget } from "react-native-android-widget";
import { HOME_WIDGETS } from "@/home-widgets/task-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../../convex/_generated/api";
import { compact, relativeTime } from "@shared/format";
import { PLATFORMS, PLATFORM_LABEL } from "@shared/platforms";
import { noticeFor, setNotice, useConnect, useNotice } from "@/lib/connect";
import { useNow } from "@/lib/hooks";
import { Button } from "@/ui/button";
import { PlatformLogo } from "@/ui/platform-logo";
import { PlusButton } from "@/ui/plus";
import { Body, Display, Label } from "@/ui/text";
import { color } from "@/theme";

type Account = NonNullable<ReturnType<typeof useQuery<typeof api.accounts.list>>>[number];

function statusOf(account: Account): string | null {
  if (account.status === "syncing") return "Syncing";
  if (account.status === "reconnect") return "Sign in again";
  if (account.status === "error") return account.lastError ?? "Sync failed";
  if (account.limited?.length) return `No access to ${account.limited.join(", ")}`;
  return null;
}

export default function Accounts() {
  const insets = useSafeAreaInsets();
  const now = useNow();
  const params = useLocalSearchParams<{ connected?: string; handle?: string; existing?: string; error?: string }>();
  const accounts = useQuery(api.accounts.list, {});
  const available = useQuery(api.connectStore.availability, {});
  const pagesAvailable = useQuery(api.connectStore.pagesAvailable, {}) === true;
  const syncNow = useMutation(api.accounts.syncNow);
  const disconnect = useMutation(api.connectStore.disconnect);
  const loadDemo = useMutation(api.accounts.loadDemo);
  const removeDemo = useMutation(api.accounts.removeDemo);
  const deleteMyAccount = useMutation(api.compliance.deleteMyAccount);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { signOut } = useClerk();
  const { user } = useUser();
  const { connect, busy } = useConnect();
  const notice = useNotice();

  // The OAuth callback can also land here as a deep link when the sign-in browser hands back to a cold app.
  useEffect(() => {
    const next = noticeFor(params, "reconnect");
    if (next) setNotice(next);
  }, [params.connected, params.error]);

  const hasDemo = accounts?.some((account) => account.source === "demo") ?? false;
  const missing = PLATFORMS.filter((platform) => !accounts?.some((account) => account.platform === platform));
  const canAdd = PLATFORMS.some((platform) => available?.[platform] === true);
  const groups = PLATFORMS.map((platform) => ({ platform, list: accounts?.filter((account) => account.platform === platform) ?? [] })).filter(
    (group) => group.list.length > 0,
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView
        style={{ backgroundColor: color.bg }}
        contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 16, paddingBottom: 112, gap: 4 }}
      >
        {notice ? (
          <View style={{ borderWidth: 2, borderColor: notice.error ? color.coral : color.fg, padding: 12, marginBottom: 12 }}>
            <Body tone={notice.error ? "coral" : "fg"}>{notice.text}</Body>
          </View>
        ) : null}

        {accounts !== undefined && groups.length === 0 && canAdd ? (
          <View style={{ alignItems: "flex-start", paddingVertical: 8 }}>
            <Button testID="connect-first" variant="primary" label="Connect an account" onPress={() => router.push("/add-account")} />
          </View>
        ) : null}

        {groups.map(({ platform, list }) => (
          <View key={platform} testID={`platform-${platform}`} style={{ paddingTop: 20, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: color.line }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingBottom: 4 }}>
              <PlatformLogo platform={platform} size={18} />
              <Display size={20}>{PLATFORM_LABEL[platform]}</Display>
            </View>
            {list.map((account) => {
              const status = statusOf(account);
              const trouble = account.status === "error" || account.status === "reconnect";
              const details = [
                account.followers ? `${compact(account.followers)} followers` : null,
                account.lastSyncedAt ? `updated ${relativeTime(account.lastSyncedAt, now)}` : null,
              ].filter(Boolean);
              const demo = account.source === "demo";
              return (
                <View key={account._id} testID={`account-${platform}`} style={{ paddingVertical: 14, gap: 10 }}>
                  <View style={{ gap: 4 }}>
                    <Body numberOfLines={1}>{demo ? "Demo data" : account.handle}</Body>
                    {status ? (
                      <Label size={10} tone={trouble ? "coral" : "dim"}>
                        {status}
                      </Label>
                    ) : null}
                    {details.length > 0 ? <Label size={10}>{details.join(" · ")}</Label> : null}
                  </View>
                  {demo ? null : (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {account.status === "reconnect" && (account.kind === "page" ? pagesAvailable : available?.[platform]) ? (
                        <Button
                          testID={`reconnect-${platform}`}
                          size="sm"
                          label={busy === platform ? "Opening" : "Sign in again"}
                          disabled={busy !== null}
                          onPress={() => void connect(platform, "reconnect", { pages: account.kind === "page" })}
                        />
                      ) : null}
                      <Button testID={`sync-${platform}`} size="sm" variant="outline" label="Sync" onPress={() => void syncNow({ accountId: account._id })} />
                      <Button size="sm" variant="ghost" label="Disconnect" onPress={() => void disconnect({ accountId: account._id })} />
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        ))}

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
          {confirmDelete ? (
            <View testID="delete-account-confirm" style={{ borderWidth: 2, borderColor: color.coral, padding: 12, gap: 12, alignSelf: "stretch" }}>
              <Body tone="coral">
                This deletes every connected account with its sign-in tokens and synced posts, stats and comments, plus your drafts, uploads, goals and
                layout. It can't be undone.
              </Body>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <Button
                  testID="delete-account-yes"
                  size="sm"
                  variant="primary"
                  label="Delete everything"
                  onPress={() => {
                    setConfirmDelete(false);
                    void deleteMyAccount({}).then(
                      () => setNotice({ text: "Deleting your data. Accounts, drafts and uploads disappear as it runs.", error: false }),
                      () => setNotice({ text: "That didn't go through. Try again.", error: true }),
                    );
                  }}
                />
                <Button testID="delete-account-no" size="sm" variant="outline" label="Keep it" onPress={() => setConfirmDelete(false)} />
              </View>
            </View>
          ) : (
            <Button testID="delete-account" variant="ghost" label="Delete my account" onPress={() => setConfirmDelete(true)} />
          )}
        </View>
      </ScrollView>
      {canAdd ? (
        <PlusButton
          testID="add-account"
          accessibilityLabel="Add account"
          onPress={() => router.push("/add-account")}
          style={{ position: "absolute", right: 16, bottom: 16 }}
        />
      ) : null}
    </View>
  );
}
