import { useAction, useConvex, useMutation, useQuery } from "convex/react";
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
  MAX_COVER_BYTES,
  MAX_DRAFT_MEDIA,
  MAX_DRAFT_TEXT,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  TEXT_LIMIT,
  YOUTUBE_TITLE_LIMIT,
  YOUTUBE_VISIBILITIES,
  YOUTUBE_VISIBILITY,
  postingIssues,
  textForPlatform,
  youtubeTitle,
  type DraftMediaInfo,
  type DraftMediaKind,
  type YoutubeVisibility,
} from "@shared/drafts";
import { PLATFORM_LABEL, type Platform } from "@shared/platforms";
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
  preview: string | null;
  progress: number;
  duration: number | null;
  picked?: Picked;
  media?: Media;
  original?: LocalImage;
  edit: ImageEdit;
};

type CoverState = {
  storageId: Id<"_storage">;
  preview: string | null;
};

type CopyTab = "core" | Platform;

const THUMB = 88;

class Refusal extends Error {}

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

function normalizeOverrides(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (value.trim().length > 0) out[key] = value;
  }
  return out;
}

function snapshot(
  title: string,
  text: string,
  platformText: Record<string, string>,
  youtubeVisibility: YoutubeVisibility,
  accountIds: readonly string[],
  media: readonly Media[],
  coverId: string | null,
): string {
  const cleanOverrides = Object.entries(normalizeOverrides(platformText)).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([title.trim(), text, cleanOverrides, youtubeVisibility, [...accountIds].sort(), media.map((item) => item.storageId), coverId]);
}

function formatWhen(timestamp: number): string {
  const date = new Date(timestamp);
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${month} ${day} at ${hh}:${mm}`;
}

function tomorrowAt(hour: number): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
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
  const schedule = useMutation(api.drafts.schedule);
  const cancelSchedule = useMutation(api.drafts.cancelSchedule);
  const updateYouTubePost = useAction(api.publish.updateYouTubePost);
  const generateUploadUrl = useMutation(api.drafts.generateUploadUrl);
  const attach = useMutation(api.media.attach);

  const [draftId, setDraftId] = useState<Id<"drafts"> | null>(id === "new" ? null : (id as Id<"drafts">));
  const existing = draftId === null ? undefined : drafts?.find((draft) => draft._id === draftId);

  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [platformText, setPlatformText] = useState<Record<string, string>>({});
  const [copyTab, setCopyTab] = useState<CopyTab>("core");
  const [youtubeVisibility, setYoutubeVisibility] = useState<YoutubeVisibility>(YOUTUBE_VISIBILITY);
  const [accountIds, setAccountIds] = useState<Id<"accounts">[]>([]);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [cover, setCover] = useState<CoverState | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
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
    const loadedTitle = existing.title ?? "";
    const loadedOverrides = existing.platformText ?? {};
    const loadedVis = existing.youtubeVisibility ?? YOUTUBE_VISIBILITY;
    const loadedCover = existing.cover ? { storageId: existing.cover.storageId, preview: existing.cover.url } : null;
    setTitle(loadedTitle);
    setText(existing.text);
    setPlatformText(loadedOverrides);
    setYoutubeVisibility(loadedVis);
    setAccountIds(ids);
    setTiles(items);
    setCover(loadedCover);
    setSavedAs(snapshot(loadedTitle, existing.text, loadedOverrides, loadedVis, ids, saved(items), loadedCover?.storageId ?? null));
    setLoaded(true);
  }, [existing, loaded]);

  const media = saved(tiles);
  const hasVideo = tiles.some((tile) => tile.kind === "video");
  const uploading = tiles.some((tile) => tile.state === "uploading") || coverBusy;
  const checked: DraftMediaInfo[] = tiles.flatMap((tile) => (tile.state === "failed" ? [] : [tile.media ?? { kind: tile.kind }]));
  const dirty = snapshot(title, text, platformText, youtubeVisibility, accountIds, media, cover?.storageId ?? null) !== savedAs;
  const status = existing?.status ?? "draft";
  const sending = status === "publishing";
  const done = status === "published";
  const locked = sending || done;

  const targetOf = (accountId: string) => existing?.targets.find((target) => target.accountId === accountId);
  const selected = (accounts ?? []).filter((account) => accountIds.includes(account._id));
  const selectedPlatforms = [...new Set(selected.map((account) => account.platform))];
  const hasYouTube = selectedPlatforms.includes("youtube");
  const remaining = selected.filter((account) => targetOf(account._id)?.state !== "published");
  const choosable = (accounts ?? []).filter((account) => targetOf(account._id)?.state !== "published");
  const results = (existing?.targets ?? []).filter((target) => target.state !== null);
  const failed = results.some((target) => target.state === "failed");

  useEffect(() => {
    if (copyTab !== "core" && !selectedPlatforms.includes(copyTab)) {
      setCopyTab("core");
    }
  }, [copyTab, selectedPlatforms]);

  const cleanOverrides = normalizeOverrides(platformText);
  const issuesByAccount = remaining.map((account) => {
    const target = targetOf(account._id);
    const issues =
      !dirty && target
        ? target.issues
        : postingIssues(account, text, checked, { permissions: false, platformText: cleanOverrides, title });
    return { handle: account.handle, issues };
  });
  const issueLines = [...new Set(issuesByAccount.flatMap((entry) => entry.issues))].map((issue) => {
    const handles = issuesByAccount.filter((entry) => entry.issues.includes(issue)).map((entry) => entry.handle);
    return handles.length === remaining.length ? issue : `${handles.join(", ")}: ${issue}`;
  });

  const activeText = copyTab === "core" ? text : (platformText[copyTab] ?? "");
  const effectiveActiveText = copyTab === "core" ? text : textForPlatform(text, copyTab, platformText);
  const length = [...effectiveActiveText.trim()].length;
  const limits =
    copyTab === "core"
      ? remaining.flatMap((account) => (cleanOverrides[account.platform] ? [] : (TEXT_LIMIT[account.platform] ?? [])))
      : TEXT_LIMIT[copyTab] !== undefined
        ? [TEXT_LIMIT[copyTab]!]
        : [];
  const limit = limits.length > 0 ? Math.min(...limits) : null;

  const blank = title.trim().length === 0 && text.trim().length === 0 && media.length === 0 && accountIds.length === 0;
  const canSave = loaded && !busy && !locked && !uploading && dirty && !(draftId === null && blank);
  const canPublish = loaded && !busy && !locked && !uploading && remaining.length > 0 && issueLines.length === 0;
  const slots = MAX_DRAFT_MEDIA - tiles.length;

  async function persist(): Promise<Id<"drafts"> | null> {
    if (!dirty && draftId !== null) return draftId;
    try {
      const savedId = await save({
        ...(draftId ? { draftId } : {}),
        title: title.trim() || null,
        text,
        platformText: Object.keys(cleanOverrides).length > 0 ? cleanOverrides : null,
        youtubeVisibility,
        accountIds,
        media,
        cover: cover ? cover.storageId : null,
      });
      setSavedAs(snapshot(title, text, cleanOverrides, youtubeVisibility, accountIds, media, cover?.storageId ?? null));
      setDraftId(savedId);
      return savedId;
    } catch (cause) {
      setError(sentence(cause, "Couldn't save. Try again."));
      return null;
    }
  }

  async function saveAndClose() {
    setError(null);
    setBusy(true);
    const savedId = await persist();
    setBusy(false);
    if (savedId) router.back();
  }

  async function send(target: Id<"drafts">, onlyAccountIds?: Id<"accounts">[]) {
    setError(null);
    setBusy(true);
    try {
      await publish({ draftId: target, ...(onlyAccountIds ? { accountIds: onlyAccountIds } : {}) });
    } catch (cause) {
      setError(sentence(cause, "Couldn't publish. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function scheduleAt(at: number) {
    setError(null);
    setBusy(true);
    const savedId = await persist();
    if (!savedId) {
      setBusy(false);
      return;
    }
    try {
      await schedule({ draftId: savedId, at });
      setShowSchedule(false);
    } catch (cause) {
      setError(sentence(cause, "Couldn't schedule. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function clearSchedule() {
    if (!draftId) return;
    setError(null);
    setBusy(true);
    try {
      await cancelSchedule({ draftId });
    } catch (cause) {
      setError(sentence(cause, "Couldn't cancel the schedule."));
    } finally {
      setBusy(false);
    }
  }

  async function makeYouTubePublic(accountId: Id<"accounts">, videoId: string) {
    setError(null);
    setBusy(true);
    try {
      await updateYouTubePost({ accountId, videoId, visibility: "public" });
      Alert.alert("YouTube video is now public.");
    } catch (cause) {
      setError(sentence(cause, "Couldn't update YouTube visibility."));
    } finally {
      setBusy(false);
    }
  }

  async function confirmPublish() {
    setError(null);
    setBusy(true);
    const savedId = await persist();
    const fresh = savedId ? (await convex.query(api.drafts.list, {})).find((draft) => draft._id === savedId) : undefined;
    setBusy(false);
    if (!savedId || !fresh) return;
    const pending = fresh.targets.filter((target) => target.state !== "published");
    if (pending.length === 0 || pending.some((target) => target.issues.length > 0)) return;
    Alert.alert(`Post to ${pending.map((target) => target.handle).join(", ")}?`, undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Publish", onPress: () => void send(savedId) },
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

  async function pickCover() {
    setError(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: false,
        quality: 1,
      });
      if (result.canceled || !result.assets[0]) return;
      setCoverBusy(true);
      const rendered = await renderImage({ uri: result.assets[0].uri });
      if (sizeOf(rendered.uri) > MAX_COVER_BYTES) {
        throw new Refusal("A cover can be up to 2 MB.");
      }
      const uploaded = await upload(rendered.uri, "image", "image/jpeg", "cover.jpg");
      setCover({ storageId: uploaded.storageId, preview: rendered.uri });
    } catch (cause) {
      setError(sentence(cause, "Couldn't set that cover. Try again."));
    } finally {
      setCoverBusy(false);
    }
  }

  async function start(key: string, picked: Picked) {
    patch(key, { state: "uploading", progress: 0 });
    try {
      let { uri, mimeType, filename } = picked;
      let original: LocalImage | undefined;
      if (picked.kind === "image") {
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
    try {
      const original = await renderImage({ uri: await downloadImage(tile.preview, tile.media.storageId) });
      patch(tile.key, { original });
    } catch {
      setEditing((current) => (current?.key === tile.key ? { key: tile.key, loadError: "Couldn't open that image. Try again." } : current));
    }
  }

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

  function updateActiveText(next: string) {
    if (copyTab === "core") {
      setText(next);
    } else {
      setPlatformText((current) => ({ ...current, [copyTab]: next }));
    }
  }

  return (
    <KeyboardAwareScrollView
      style={{ backgroundColor: color.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32, paddingHorizontal: 16, gap: 20 }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <Button testID="close-draft" size="sm" variant="outline" label="Close" onPress={() => router.back()} />
        {done ? null : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
            <Button testID="save-draft" size="sm" label="Save" disabled={!canSave} onPress={() => void saveAndClose()} />
            <Button
              testID="schedule-draft"
              size="sm"
              variant="outline"
              label={existing?.scheduledFor ? "Scheduled" : "Schedule"}
              disabled={!canPublish}
              onPress={() => setShowSchedule((prev) => !prev)}
            />
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

      {existing?.scheduledFor ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 2, borderColor: color.coral, padding: 10, gap: 10 }}>
          <Label tone="coral">Scheduled · {formatWhen(existing.scheduledFor)}</Label>
          <Button size="sm" variant="ghost" label="Cancel" disabled={busy} onPress={() => void clearSchedule()} />
        </View>
      ) : null}

      {showSchedule && !locked ? (
        <View style={{ borderWidth: 2, borderColor: color.line, padding: 12, gap: 10 }}>
          <Label tone="dim">Publish automatically</Label>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button size="sm" variant="outline" label="In 1 hour" disabled={busy} onPress={() => void scheduleAt(Date.now() + 3_600_000)} />
            <Button size="sm" variant="outline" label="In 3 hours" disabled={busy} onPress={() => void scheduleAt(Date.now() + 3 * 3_600_000)} />
            <Button size="sm" variant="outline" label="Tomorrow 09:00" disabled={busy} onPress={() => void scheduleAt(tomorrowAt(9))} />
            <Button size="sm" variant="outline" label="Tomorrow 18:00" disabled={busy} onPress={() => void scheduleAt(tomorrowAt(18))} />
          </View>
        </View>
      ) : null}

      {accounts === undefined ? null : accounts.length === 0 ? (
        <View style={{ alignItems: "flex-start" }}>
          <Button testID="draft-connect" variant="outline" label="Connect an account" onPress={() => router.push("/add-account")} />
        </View>
      ) : choosable.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Label tone="dim">Accounts</Label>
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
        </View>
      ) : null}

      {hasYouTube ? (
        <View style={{ gap: 10, borderWidth: 1, borderColor: color.line, padding: 12 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Label tone="dim">YouTube title & visibility</Label>
            <Label size={10} tone={[...title.trim()].length > YOUTUBE_TITLE_LIMIT ? "coral" : "faint"}>
              {[...title.trim()].length}/{YOUTUBE_TITLE_LIMIT}
            </Label>
          </View>
          <TextInput
            value={title}
            onChangeText={setTitle}
            editable={!locked}
            maxLength={YOUTUBE_TITLE_LIMIT * 2}
            placeholder="Video title (defaults to first line)"
            placeholderTextColor={color.faint}
            style={{
              fontFamily: font.mono,
              fontSize: 14,
              color: color.fg,
              paddingVertical: 6,
              borderBottomWidth: 2,
              borderBottomColor: color.line,
            }}
          />
          <View style={{ flexDirection: "row", gap: 8 }}>
            {YOUTUBE_VISIBILITIES.map((vis) => {
              const active = youtubeVisibility === vis;
              return (
                <Pressable
                  key={vis}
                  disabled={locked}
                  onPress={() => setYoutubeVisibility(vis)}
                  style={{
                    height: 30,
                    paddingHorizontal: 10,
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: 2,
                    borderColor: active ? color.fg : color.line,
                    backgroundColor: active ? color.fg : "transparent",
                  }}
                >
                  <Label size={10} tone={active ? "bg" : "fg"}>
                    {vis}
                  </Label>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      <View style={{ gap: 8 }}>
        {selectedPlatforms.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            {(["core", ...selectedPlatforms] as CopyTab[]).map((tab) => {
              const active = copyTab === tab;
              const customized = tab !== "core" && Boolean(cleanOverrides[tab]);
              return (
                <Pressable
                  key={tab}
                  onPress={() => setCopyTab(tab)}
                  style={{
                    height: 28,
                    paddingHorizontal: 10,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 5,
                    borderWidth: 2,
                    borderColor: active ? color.fg : color.line,
                    backgroundColor: active ? color.fg : "transparent",
                  }}
                >
                  <Label size={10} tone={active ? "bg" : "fg"}>
                    {tab === "core" ? "Core" : PLATFORM_LABEL[tab]}
                  </Label>
                  {customized ? (
                    <View style={{ width: 6, height: 6, backgroundColor: active ? color.bg : color.coral }} />
                  ) : null}
                </Pressable>
              );
            })}
            {copyTab !== "core" && cleanOverrides[copyTab] && !locked ? (
              <Button
                size="sm"
                variant="ghost"
                label="Use core"
                onPress={() =>
                  setPlatformText((current) => {
                    const next = { ...current };
                    delete next[copyTab];
                    return next;
                  })
                }
              />
            ) : null}
          </View>
        ) : null}

        {loaded ? (
          <TextInput
            testID="draft-text"
            accessibilityLabel="Post text"
            value={activeText}
            onChangeText={updateActiveText}
            editable={!locked}
            autoFocus={!locked && copyTab === "core"}
            multiline
            maxLength={MAX_DRAFT_TEXT}
            placeholder={
              copyTab === "core"
                ? "Write your post"
                : `Override for ${PLATFORM_LABEL[copyTab]} (blank uses core post)`
            }
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

      {tiles.length > 0 || !locked ? (
        <View style={{ gap: 12 }}>
          {tiles.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
              {tiles.map((tile, index) => {
                const name = `${tile.kind === "video" ? "Video" : "Image"} ${index + 1}`;
                const editable = !locked && tile.kind === "image" && tile.state === "ready";
                const retry = tile.state === "failed" && tile.picked ? tile.picked : null;
                const tileStatus =
                  tile.state === "failed" ? "Retry" : tile.state === "uploading" ? (tile.progress > 0 ? `${Math.round(tile.progress * 100)}%` : "Uploading") : null;
                return (
                  <View
                    key={tile.key}
                    style={{ width: THUMB, height: THUMB, borderWidth: 2, borderColor: tile.state === "failed" ? color.coral : color.line }}
                  >
                    <Pressable
                      testID={retry ? `draft-media-retry-${index}` : `draft-media-edit-${index}`}
                      accessibilityRole="button"
                      accessibilityLabel={retry ? `${name} failed. Try again` : editable ? `Edit ${name}` : tileStatus ? `${name}, ${tileStatus}` : name}
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
                      {tileStatus || editable ? (
                        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingVertical: 2, alignItems: "center", backgroundColor: color.bg }}>
                          <Label testID={`draft-media-status-${index}`} tone={tile.state === "failed" ? "coral" : "fg"}>
                            {tileStatus ?? "Edit"}
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
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
              <Button testID="draft-add-media" size="sm" variant="outline" label="Add media" disabled={uploading} onPress={() => void add("library")} />
              <Button testID="draft-camera" size="sm" variant="outline" label="Camera" disabled={uploading} onPress={openCamera} />
              {hasVideo ? (
                <Button
                  size="sm"
                  variant="outline"
                  label={coverBusy ? "Uploading…" : cover ? "Change cover" : "Add cover"}
                  disabled={uploading}
                  onPress={() => void pickCover()}
                />
              ) : null}
              <Label testID="draft-media-count">
                {tiles.length}/{MAX_DRAFT_MEDIA}
              </Label>
            </View>
          ) : (
            <Label testID="draft-media-count">
              {tiles.length}/{MAX_DRAFT_MEDIA} attached
            </Label>
          )}
          {hasVideo && cover ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              {cover.preview ? (
                <Image source={{ uri: cover.preview }} style={{ width: 56, height: 56, borderWidth: 2, borderColor: color.line }} resizeMode="cover" />
              ) : null}
              <Label tone="dim">Video cover (YouTube + Reel)</Label>
              {!locked ? <Button size="sm" variant="ghost" label="Remove" onPress={() => setCover(null)} /> : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {selected.length > 0 ? (
        <View style={{ gap: 10 }}>
          <Pressable onPress={() => setShowPreview((prev) => !prev)}>
            <Label tone="dim">{showPreview ? "Hide previews" : `Preview across ${selected.length} account${selected.length === 1 ? "" : "s"}`}</Label>
          </Pressable>
          {showPreview
            ? selected.map((account) => {
                const resolved = textForPlatform(text, account.platform, cleanOverrides).trim();
                const yt = account.platform === "youtube" ? youtubeTitle(resolved, media[0]?.filename, title) : null;
                return (
                  <View key={account._id} style={{ borderWidth: 1, borderColor: color.line, padding: 12, gap: 6 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <PlatformLogo platform={account.platform} size={12} opacity={0.85} />
                      <Label size={10} tone="fg">
                        {PLATFORM_LABEL[account.platform]} · {account.handle}
                      </Label>
                      {account.platform === "youtube" ? (
                        <Label size={10} tone="faint">
                          · {youtubeVisibility}
                        </Label>
                      ) : null}
                    </View>
                    {yt ? <Body style={{ fontFamily: font.monoBold }}>{yt}</Body> : null}
                    <Body tone={resolved ? "fg" : "faint"} style={{ fontSize: 13, lineHeight: 19 }}>
                      {resolved || "(No text)"}
                    </Body>
                  </View>
                );
              })
            : null}
        </View>
      ) : null}

      {results.length > 0 ? (
        <View style={{ gap: 12 }}>
          {results.map((target) => (
            <View key={target.accountId} testID={`draft-result-${target.accountId}`} style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <PlatformLogo platform={target.platform} size={12} opacity={0.7} />
                <Label size={11} tone="fg" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {target.handle}
                </Label>
                <View style={{ flex: 1 }} />
                {target.state === "published" && target.platform === "youtube" && target.platformPostId && youtubeVisibility !== "public" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    label="Make public"
                    disabled={busy}
                    onPress={() => void makeYouTubePublic(target.accountId, target.platformPostId!)}
                  />
                ) : null}
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
                ) : target.state === "failed" && draftId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    label="Retry"
                    disabled={busy}
                    onPress={() => void send(draftId, [target.accountId])}
                  />
                ) : (
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
