import { useConvex, useMutation, useQuery } from "convex/react";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as Linking from "expo-linking";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Image, Pressable, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { MAX_DRAFT_MEDIA, MAX_DRAFT_TEXT, TEXT_LIMIT, postingIssues, type DraftMediaKind } from "@shared/drafts";
import { Button } from "@/ui/button";
import { PlatformLogo } from "@/ui/platform-logo";
import { PlusGlyph } from "@/ui/plus";
import { Body, Label } from "@/ui/text";
import { color, font } from "@/theme";

type Media = {
  storageId: Id<"_storage">;
  kind: DraftMediaKind;
  mimeType: string;
  byteSize: number;
  filename?: string;
  /** What the thumbnail shows: the picked file until the saved copy has a link. */
  preview: string | null;
};

const THUMB = 64;

/** The sentence the server wrote for the person, or `fallback` when it sent none. */
function sentence(cause: unknown, fallback: string): string {
  const match = cause instanceof Error ? /Uncaught Error: ([^\n]+)/.exec(cause.message) : null;
  return match?.[1]?.trim() || fallback;
}

function snapshot(text: string, accountIds: readonly string[], media: readonly Media[]): string {
  return JSON.stringify([text, [...accountIds].sort(), media.map((item) => item.storageId)]);
}

export default function DraftEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const convex = useConvex();
  const drafts = useQuery(api.drafts.list, {});
  const accounts = useQuery(api.accounts.list, {});
  const save = useMutation(api.drafts.save);
  const remove = useMutation(api.drafts.remove);
  const publish = useMutation(api.drafts.publish);
  const generateUploadUrl = useMutation(api.drafts.generateUploadUrl);

  // A new draft gets its ID on the first save; the screen then follows it live.
  const [draftId, setDraftId] = useState<Id<"drafts"> | null>(id === "new" ? null : (id as Id<"drafts">));
  const existing = draftId === null ? undefined : drafts?.find((draft) => draft._id === draftId);

  const [text, setText] = useState("");
  const [accountIds, setAccountIds] = useState<Id<"accounts">[]>([]);
  const [media, setMedia] = useState<Media[]>([]);
  const [uploading, setUploading] = useState<string[]>([]);
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(draftId === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loaded || !existing) return;
    const ids = existing.targets.map((target) => target.accountId);
    const items: Media[] = existing.media.map((item) => ({
      storageId: item.storageId,
      kind: item.kind,
      mimeType: item.mimeType,
      byteSize: item.byteSize,
      ...(item.filename ? { filename: item.filename } : {}),
      preview: item.url,
    }));
    setText(existing.text);
    setAccountIds(ids);
    setMedia(items);
    setSavedAs(snapshot(existing.text, ids, items));
    setLoaded(true);
  }, [existing, loaded]);

  const dirty = snapshot(text, accountIds, media) !== savedAs;
  const status = existing?.status ?? "draft";
  const sending = status === "publishing";
  const done = status === "published";
  const locked = sending || done;

  const targetOf = (accountId: string) => existing?.targets.find((target) => target.accountId === accountId);
  const selected = (accounts ?? []).filter((account) => accountIds.includes(account._id));
  // What already went out stays out; only the rest can still be edited, checked and sent.
  const remaining = selected.filter((account) => targetOf(account._id)?.state !== "published");
  const choosable = (accounts ?? []).filter((account) => targetOf(account._id)?.state !== "published");
  const results = (existing?.targets ?? []).filter((target) => target.state !== null);
  const failed = results.some((target) => target.state === "failed");

  // Saved drafts show the server's verdict. Unsaved edits are checked here so feedback is instant;
  // whether X allows images is only known to the server, so that one shows after saving.
  const issuesByAccount = remaining.map((account) => {
    const target = targetOf(account._id);
    const issues = !dirty && target ? target.issues : postingIssues({ ...account, scopes: ["media.write"] }, text, media);
    return { handle: account.handle, issues };
  });
  const issueLines = [...new Set(issuesByAccount.flatMap((entry) => entry.issues))].map((issue) => {
    const handles = issuesByAccount.filter((entry) => entry.issues.includes(issue)).map((entry) => entry.handle);
    return handles.length === remaining.length ? issue : `${handles.join(", ")}: ${issue}`;
  });

  const length = [...text.trim()].length;
  const limits = remaining.flatMap((account) => TEXT_LIMIT[account.platform] ?? []);
  const limit = limits.length > 0 ? Math.min(...limits) : null;

  const blank = text.trim().length === 0 && media.length === 0 && accountIds.length === 0;
  const canSave = loaded && !busy && !locked && uploading.length === 0 && dirty && !(draftId === null && blank);
  const canPublish = loaded && !busy && !locked && uploading.length === 0 && remaining.length > 0 && issueLines.length === 0;

  /** Saves pending edits and returns the draft's ID, or null when saving failed. */
  async function persist(): Promise<Id<"drafts"> | null> {
    if (!dirty && draftId !== null) return draftId;
    try {
      const saved = await save({
        ...(draftId ? { draftId } : {}),
        text,
        accountIds,
        media: media.map(({ preview: _preview, ...item }) => item),
      });
      setSavedAs(snapshot(text, accountIds, media));
      setDraftId(saved);
      return saved;
    } catch (cause) {
      setError(sentence(cause, "Couldn't save. Try again."));
      return null;
    }
  }

  async function saveAndClose() {
    setError(null);
    setBusy(true);
    const saved = await persist();
    setBusy(false);
    if (saved) router.back();
  }

  async function send(target: Id<"drafts">) {
    setError(null);
    setBusy(true);
    try {
      await publish({ draftId: target });
    } catch (cause) {
      setError(sentence(cause, "Couldn't publish. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function confirmPublish() {
    setError(null);
    setBusy(true);
    const saved = await persist();
    // The server has the last word: it may know a reason this screen couldn't check.
    const fresh = saved ? (await convex.query(api.drafts.list, {})).find((draft) => draft._id === saved) : undefined;
    setBusy(false);
    if (!saved || !fresh) return;
    const pending = fresh.targets.filter((target) => target.state !== "published");
    if (pending.length === 0 || pending.some((target) => target.issues.length > 0)) return;
    Alert.alert(`Post to ${pending.map((target) => target.handle).join(", ")}?`, undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Publish", onPress: () => void send(saved) },
    ]);
  }

  function confirmDelete() {
    if (draftId === null) return;
    Alert.alert("Delete this draft?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void remove({ draftId });
          router.back();
        },
      },
    ]);
  }

  async function addImages() {
    setError(null);
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: MAX_DRAFT_MEDIA - media.length,
      quality: 0.9,
    });
    if (picked.canceled) return;
    const assets = picked.assets.slice(0, MAX_DRAFT_MEDIA - media.length);
    setUploading(assets.map((asset) => asset.uri));
    for (const asset of assets) {
      try {
        const mimeType = asset.mimeType ?? "image/jpeg";
        const blob = await (await fetch(asset.uri)).blob();
        const response = await fetch(await generateUploadUrl({}), { method: "POST", headers: { "Content-Type": mimeType }, body: blob });
        if (!response.ok) throw new Error("Upload failed");
        const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
        const item: Media = {
          storageId,
          kind: "image",
          mimeType,
          byteSize: asset.fileSize ?? blob.size,
          ...(asset.fileName ? { filename: asset.fileName } : {}),
          preview: asset.uri,
        };
        setMedia((current) => (current.length < MAX_DRAFT_MEDIA ? [...current, item] : current));
      } catch {
        setError("Couldn't add that image. Try again.");
      } finally {
        setUploading((current) => current.filter((uri) => uri !== asset.uri));
      }
    }
  }

  function toggle(accountId: Id<"accounts">) {
    void Haptics.selectionAsync();
    setAccountIds((current) => (current.includes(accountId) ? current.filter((other) => other !== accountId) : [...current, accountId]));
  }

  return (
    <KeyboardAwareScrollView
      style={{ backgroundColor: color.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32, paddingHorizontal: 16, gap: 24 }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <Button testID="close-draft" size="sm" variant="outline" label="Close" onPress={() => router.back()} />
        {done ? null : (
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Button testID="save-draft" size="sm" label="Save" disabled={!canSave} onPress={() => void saveAndClose()} />
            <Button
              testID="publish-draft"
              size="sm"
              variant="primary"
              label={failed ? "Try again" : "Publish"}
              disabled={!canPublish}
              onPress={() => void confirmPublish()}
            />
          </View>
        )}
      </View>

      <View style={{ gap: 8 }}>
        {loaded ? (
          <TextInput
            testID="draft-text"
            accessibilityLabel="Post text"
            value={text}
            onChangeText={setText}
            editable={!locked}
            autoFocus={!locked}
            multiline
            maxLength={MAX_DRAFT_TEXT}
            placeholder="Write your post"
            placeholderTextColor={color.faint}
            textAlignVertical="top"
            style={{
              fontFamily: font.mono,
              fontSize: 16,
              lineHeight: 24,
              color: color.fg,
              minHeight: 144,
              paddingVertical: 6,
              borderBottomWidth: 3,
              borderBottomColor: length > 0 ? color.coral : color.line,
            }}
          />
        ) : null}
        {limit !== null ? (
          <Label testID="draft-count" size={11} tone={length > limit ? "coral" : "dim"} style={{ alignSelf: "flex-end" }}>
            {length}/{limit}
          </Label>
        ) : null}
        {issueLines.length > 0 ? (
          <View testID="draft-issues" style={{ gap: 4 }}>
            {issueLines.map((line) => (
              <Body key={line} tone="coral">
                {line}
              </Body>
            ))}
          </View>
        ) : null}
      </View>

      {accounts === undefined ? null : accounts.length === 0 ? (
        <View style={{ alignItems: "flex-start" }}>
          <Button testID="draft-connect" variant="outline" label="Connect an account" onPress={() => router.push("/add-account")} />
        </View>
      ) : choosable.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {choosable.map((account) => {
            const active = accountIds.includes(account._id);
            return (
              <Pressable
                key={account._id}
                testID={`draft-account-${account._id}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: active, disabled: locked }}
                accessibilityLabel={account.handle}
                disabled={locked}
                onPress={() => toggle(account._id)}
                hitSlop={{ top: 6, bottom: 6 }}
                style={{
                  height: 32,
                  paddingHorizontal: 10,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  borderWidth: 2,
                  borderColor: active ? color.coral : color.line,
                  backgroundColor: active ? color.coral : "transparent",
                }}
              >
                <PlatformLogo platform={account.platform} size={14} tint={active ? color.bg : color.fg} />
                <Label size={11} tone={active ? "bg" : "fg"} numberOfLines={1}>
                  {account.handle}
                </Label>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {media.length > 0 || uploading.length > 0 || !locked ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          {media.map((item, index) => (
            <View key={item.storageId} style={{ width: THUMB, height: THUMB, borderWidth: 2, borderColor: color.line }}>
              {item.kind === "image" && item.preview ? (
                <Image
                  testID={`draft-media-${index}`}
                  accessibilityLabel={`Image ${index + 1}`}
                  source={{ uri: item.preview }}
                  style={{ width: THUMB - 4, height: THUMB - 4 }}
                  resizeMode="cover"
                />
              ) : (
                <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                  <Label>{item.kind === "video" ? "Video" : "Image"}</Label>
                </View>
              )}
              {locked ? null : (
                <Pressable
                  testID={`draft-media-remove-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${item.kind} ${index + 1}`}
                  onPress={() => setMedia((current) => current.filter((other) => other.storageId !== item.storageId))}
                  hitSlop={8}
                  style={{
                    position: "absolute",
                    top: -8,
                    right: -8,
                    width: 22,
                    height: 22,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: color.bg,
                    borderWidth: 2,
                    borderColor: color.fg,
                  }}
                >
                  <View style={{ transform: [{ rotate: "45deg" }] }}>
                    <PlusGlyph size={10} thickness={2} tint={color.fg} />
                  </View>
                </Pressable>
              )}
            </View>
          ))}
          {uploading.map((uri) => (
            <View key={uri} style={{ width: THUMB, height: THUMB, borderWidth: 2, borderColor: color.line, opacity: 0.6 }}>
              <Image accessibilityLabel="Uploading image" source={{ uri }} style={{ width: THUMB - 4, height: THUMB - 4 }} resizeMode="cover" />
            </View>
          ))}
          {locked || media.length + uploading.length >= MAX_DRAFT_MEDIA ? null : (
            <Button testID="draft-add-image" size="sm" variant="outline" label="Add image" disabled={uploading.length > 0} onPress={() => void addImages()} />
          )}
        </View>
      ) : null}

      {results.length > 0 ? (
        <View style={{ gap: 12 }}>
          {results.map((target) => (
            <View key={target.accountId} testID={`draft-result-${target.accountId}`} style={{ gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <PlatformLogo platform={target.platform} size={12} opacity={0.7} />
                <Label size={11} tone="fg" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {target.handle}
                </Label>
                <View style={{ flex: 1 }} />
                {target.state === "published" && target.permalink ? (
                  <Pressable
                    testID={`draft-link-${target.accountId}`}
                    accessibilityRole="link"
                    accessibilityLabel={`View the post on ${target.handle}`}
                    hitSlop={10}
                    onPress={() => void Linking.openURL(target.permalink!)}
                  >
                    <Label size={11} tone="coral">
                      View post
                    </Label>
                  </Pressable>
                ) : target.state === "failed" ? null : (
                  <Label size={11}>{target.state === "published" ? "Published" : "Publishing"}</Label>
                )}
              </View>
              {target.state === "failed" ? <Body tone="coral">{target.error ?? "Couldn't publish."}</Body> : null}
            </View>
          ))}
        </View>
      ) : null}

      {error ? (
        <Body testID="draft-error" tone="coral">
          {error}
        </Body>
      ) : null}

      {draftId !== null && !sending ? (
        <View style={{ alignItems: "flex-start" }}>
          <Button testID="delete-draft" variant="outline" label="Delete" disabled={busy} onPress={confirmDelete} />
        </View>
      ) : null}
    </KeyboardAwareScrollView>
  );
}
