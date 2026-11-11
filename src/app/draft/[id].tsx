import { useConvex, useMutation, useQuery } from "convex/react";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as Linking from "expo-linking";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Image, Pressable, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  MAX_DRAFT_MEDIA,
  MAX_DRAFT_TEXT,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  TEXT_LIMIT,
  postingIssues,
  type DraftMediaInfo,
  type DraftMediaKind,
} from "@shared/drafts";
import { NO_EDIT, downloadImage, formatDuration, isEdited, renderImage, sizeOf, uploadFile, type ImageEdit, type LocalImage } from "@/lib/media";
import { Button } from "@/ui/button";
import { MediaEditor } from "@/ui/media-editor";
import { PlatformLogo } from "@/ui/platform-logo";
import { PlusGlyph } from "@/ui/plus";
import { Body, Label } from "@/ui/text";
import { color, font } from "@/theme";

/** A file as the server recorded it. */
type Media = {
  storageId: Id<"_storage">;
  kind: DraftMediaKind;
  mimeType: string;
  byteSize: number;
  filename?: string;
};

type Picked = { uri: string; kind: DraftMediaKind; mimeType: string; filename?: string; duration: number | null };

/** One attachment on screen, from the moment it is picked. Only `ready` tiles are part of the draft. */
type Tile = {
  key: string;
  kind: DraftMediaKind;
  state: "uploading" | "failed" | "ready";
  /** What the thumbnail shows: the local file until only the saved copy's link is known. */
  preview: string | null;
  /** Upload progress from 0 to 1. */
  progress: number;
  duration: number | null;
  /** Kept so a failed upload can be tried again. */
  picked?: Picked;
  media?: Media;
  /** The unedited image, so every edit starts from it instead of stacking on the last one. */
  original?: LocalImage;
  edit: ImageEdit;
};

const THUMB = 88;

/** A reason worded here for the person, as opposed to one the server sent. */
class Refusal extends Error {}

/** The sentence the server wrote for the person, or `fallback` when it sent none. */
function sentence(cause: unknown, fallback: string): string {
  const match = cause instanceof Error ? /Uncaught Error: ([^\n]+)/.exec(cause.message) : null;
  if (cause instanceof Refusal) return cause.message;
  return match?.[1]?.trim() || fallback;
}

function tooBig(kind: DraftMediaKind): string {
  return kind === "image" ? "Images can be up to 20 MB." : "Videos can be up to 200 MB. Trim it or export it smaller.";
}

function saved(tiles: readonly Tile[]): Media[] {
  return tiles.flatMap((tile) => (tile.state === "ready" && tile.media ? [tile.media] : []));
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
  const attach = useMutation(api.media.attach);

  // A new draft gets its ID on the first save; the screen then follows it live.
  const [draftId, setDraftId] = useState<Id<"drafts"> | null>(id === "new" ? null : (id as Id<"drafts">));
  const existing = draftId === null ? undefined : drafts?.find((draft) => draft._id === draftId);

  const [text, setText] = useState("");
  const [accountIds, setAccountIds] = useState<Id<"accounts">[]>([]);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [editing, setEditing] = useState<{ key: string; loadError: string | null } | null>(null);
  const nextKey = useRef(0);
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(draftId === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loaded || !existing) return;
    const ids = existing.targets.map((target) => target.accountId);
    const items: Tile[] = existing.media.map((item) => ({
      key: item.storageId,
      kind: item.kind,
      state: "ready",
      preview: item.url,
      progress: 1,
      duration: null,
      media: {
        storageId: item.storageId,
        kind: item.kind,
        mimeType: item.mimeType,
        byteSize: item.byteSize,
        ...(item.filename ? { filename: item.filename } : {}),
      },
      edit: NO_EDIT,
    }));
    setText(existing.text);
    setAccountIds(ids);
    setTiles(items);
    setSavedAs(snapshot(existing.text, ids, saved(items)));
    setLoaded(true);
  }, [existing, loaded]);

  const media = saved(tiles);
  const uploading = tiles.some((tile) => tile.state === "uploading");
  // A file still on its way counts by its kind, so "one video on its own" shows before the upload ends.
  const checked: DraftMediaInfo[] = tiles.flatMap((tile) => (tile.state === "failed" ? [] : [tile.media ?? { kind: tile.kind }]));
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
    const issues = !dirty && target ? target.issues : postingIssues({ ...account, scopes: ["media.write"] }, text, checked);
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
  const canSave = loaded && !busy && !locked && !uploading && dirty && !(draftId === null && blank);
  const canPublish = loaded && !busy && !locked && !uploading && remaining.length > 0 && issueLines.length === 0;
  const slots = MAX_DRAFT_MEDIA - tiles.length;

  /** Saves pending edits and returns the draft's ID, or null when saving failed. */
  async function persist(): Promise<Id<"drafts"> | null> {
    if (!dirty && draftId !== null) return draftId;
    try {
      const saved = await save({
        ...(draftId ? { draftId } : {}),
        text,
        accountIds,
        media,
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

  function patch(key: string, change: Partial<Tile>) {
    setTiles((current) => current.map((tile) => (tile.key === key ? { ...tile, ...change } : tile)));
  }

  /** Uploads a local file and returns the server's own record of it. */
  async function upload(uri: string, kind: DraftMediaKind, mimeType: string, filename: string | undefined, onProgress?: (fraction: number) => void) {
    if (sizeOf(uri) > (kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES)) throw new Refusal(tooBig(kind));
    const storageId = (await uploadFile(uri, mimeType, await generateUploadUrl({}), onProgress)) as Id<"_storage">;
    const record = await attach({ storageId, ...(filename ? { filename } : {}) });
    const item: Media = {
      storageId: record.storageId,
      kind: record.kind,
      mimeType: record.mimeType,
      byteSize: record.byteSize,
      ...(record.filename ? { filename: record.filename } : {}),
    };
    return item;
  }

  async function start(key: string, picked: Picked) {
    patch(key, { state: "uploading", progress: 0 });
    try {
      let { uri, mimeType, filename } = picked;
      let original: LocalImage | undefined;
      if (picked.kind === "image") {
        // HEIC and WebP are refused by X and LinkedIn, so every image goes up as a JPEG.
        original = await renderImage(picked);
        uri = original.uri;
        mimeType = "image/jpeg";
        if (filename) filename = `${filename.replace(/\.[^.]+$/, "")}.jpg`;
        patch(key, { original, preview: uri });
      }
      const item = await upload(uri, picked.kind, mimeType, filename, (fraction) => patch(key, { progress: fraction }));
      patch(key, { state: "ready", media: item, kind: item.kind, progress: 1 });
    } catch (cause) {
      patch(key, { state: "failed" });
      setError(sentence(cause, `Couldn't add that ${picked.kind}. Try again.`));
    }
  }

  async function add(from: "library" | "photo" | "video") {
    setError(null);
    if (slots <= 0) return;
    let result: ImagePicker.ImagePickerResult;
    try {
      if (from === "library") {
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images", "videos"],
          allowsMultipleSelection: true,
          selectionLimit: slots,
          // Images are re-encoded once, here, so the picker must not compress them first.
          quality: 1,
        });
      } else {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          setError("Allow camera access in Settings to take a photo or video here.");
          return;
        }
        result = await ImagePicker.launchCameraAsync({ mediaTypes: from === "photo" ? ["images"] : ["videos"], quality: 1 });
      }
    } catch {
      setError(from === "library" ? "Couldn't open your library. Try again." : "Couldn't open the camera. Try again.");
      return;
    }
    if (result.canceled) return;
    const added: { key: string; picked: Picked }[] = [];
    for (const asset of result.assets.slice(0, slots)) {
      const kind: DraftMediaKind = asset.type === "video" || asset.mimeType?.startsWith("video/") ? "video" : "image";
      // An image is re-encoded smaller before it goes up; a video goes as it is, so it is refused here.
      if (kind === "video" && (asset.fileSize ?? 0) > MAX_VIDEO_BYTES) {
        setError(tooBig("video"));
        continue;
      }
      const picked: Picked = {
        uri: asset.uri,
        kind,
        mimeType: asset.mimeType ?? (kind === "video" ? "video/mp4" : "image/jpeg"),
        ...(asset.fileName ? { filename: asset.fileName } : {}),
        duration: kind === "video" ? (asset.duration ?? null) : null,
      };
      added.push({ key: `picked-${nextKey.current++}`, picked });
    }
    setTiles((current) => [
      ...current,
      ...added.map(({ key, picked }): Tile => ({
        key,
        kind: picked.kind,
        state: "uploading",
        preview: picked.kind === "image" ? picked.uri : null,
        progress: 0,
        duration: picked.duration,
        picked,
        edit: NO_EDIT,
      })),
    ]);
    // One at a time: several large uploads at once starve each other on a phone connection.
    for (const { key, picked } of added) await start(key, picked);
  }

  function openCamera() {
    Alert.alert("Camera", undefined, [
      { text: "Take photo", onPress: () => void add("photo") },
      { text: "Record video", onPress: () => void add("video") },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function openEditor(tile: Tile) {
    setError(null);
    setEditing({ key: tile.key, loadError: null });
    if (tile.original || !tile.media || !tile.preview) return;
    // A draft opened again only has the saved copy, so that becomes the image edits start from.
    try {
      const original = await renderImage({ uri: await downloadImage(tile.preview, tile.media.storageId) });
      patch(tile.key, { original });
    } catch {
      setEditing((current) => (current?.key === tile.key ? { key: tile.key, loadError: "Couldn't open that image. Try again." } : current));
    }
  }

  /** Renders the edit from the original and swaps the new file in at the same position. */
  async function applyEdit(key: string, edit: ImageEdit): Promise<string | null> {
    const tile = tiles.find((other) => other.key === key);
    if (!tile?.original) return "Couldn't open that image. Try again.";
    try {
      const rendered = isEdited(edit) ? await renderImage(tile.original, edit) : tile.original;
      const item = await upload(rendered.uri, "image", "image/jpeg", tile.media?.filename);
      patch(key, { media: item, preview: rendered.uri, edit });
      setEditing(null);
      return null;
    } catch (cause) {
      return sentence(cause, "Couldn't save the edit. Try again.");
    }
  }

  const edited = editing ? tiles.find((tile) => tile.key === editing.key) : undefined;

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

      {tiles.length > 0 || !locked ? (
        <View style={{ gap: 12 }}>
          {tiles.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
              {tiles.map((tile, index) => {
                const name = `${tile.kind === "video" ? "Video" : "Image"} ${index + 1}`;
                const editable = !locked && tile.kind === "image" && tile.state === "ready";
                const retry = tile.state === "failed" && tile.picked ? tile.picked : null;
                const status =
                  tile.state === "failed" ? "Retry" : tile.state === "uploading" ? (tile.progress > 0 ? `${Math.round(tile.progress * 100)}%` : "Uploading") : null;
                return (
                  <View
                    key={tile.key}
                    style={{ width: THUMB, height: THUMB, borderWidth: 2, borderColor: tile.state === "failed" ? color.coral : color.line }}
                  >
                    <Pressable
                      testID={retry ? `draft-media-retry-${index}` : `draft-media-edit-${index}`}
                      accessibilityRole="button"
                      accessibilityLabel={retry ? `${name} failed. Try again` : editable ? `Edit ${name}` : status ? `${name}, ${status}` : name}
                      disabled={!retry && !editable}
                      onPress={() => (retry ? void start(tile.key, retry) : void openEditor(tile))}
                      style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
                    >
                      {tile.kind === "image" && tile.preview ? (
                        <Image
                          testID={`draft-media-${index}`}
                          source={{ uri: tile.preview }}
                          style={{ position: "absolute", width: THUMB - 4, height: THUMB - 4, opacity: tile.state === "ready" ? 1 : 0.4 }}
                          resizeMode="cover"
                        />
                      ) : (
                        <View testID={`draft-media-${index}`} style={{ alignItems: "center", gap: 2, opacity: tile.state === "ready" ? 1 : 0.6 }}>
                          <Label tone="fg">{tile.kind === "video" ? "Video" : "Image"}</Label>
                          {tile.duration ? <Label>{formatDuration(tile.duration)}</Label> : null}
                        </View>
                      )}
                      {status || editable ? (
                        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingVertical: 2, alignItems: "center", backgroundColor: color.bg }}>
                          <Label testID={`draft-media-status-${index}`} tone={tile.state === "failed" ? "coral" : "fg"}>
                            {status ?? "Edit"}
                          </Label>
                        </View>
                      ) : null}
                    </Pressable>
                    {locked || tile.state === "uploading" ? null : (
                      <Pressable
                        testID={`draft-media-remove-${index}`}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${name}`}
                        onPress={() => setTiles((current) => current.filter((other) => other.key !== tile.key))}
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
                );
              })}
            </View>
          ) : null}
          {locked ? null : slots > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
              <Button testID="draft-add-media" size="sm" variant="outline" label="Add media" disabled={uploading} onPress={() => void add("library")} />
              <Button testID="draft-camera" size="sm" variant="outline" label="Camera" disabled={uploading} onPress={openCamera} />
              <Label testID="draft-media-count">
                {tiles.length}/{MAX_DRAFT_MEDIA}
              </Label>
            </View>
          ) : (
            <Label testID="draft-media-count">
              {tiles.length}/{MAX_DRAFT_MEDIA} attached
            </Label>
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
      {editing && edited ? (
        <MediaEditor
          key={editing.key}
          source={edited.original ?? null}
          loadError={editing.loadError}
          initial={edited.edit}
          onCancel={() => setEditing(null)}
          onDone={(edit) => applyEdit(editing.key, edit)}
        />
      ) : null}
    </KeyboardAwareScrollView>
  );
}
