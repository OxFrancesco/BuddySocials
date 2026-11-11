import { useState } from "react";
import { Image, Modal, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NO_EDIT, SHAPES, isEdited, turned, type ImageEdit, type LocalImage } from "@/lib/media";
import { color } from "@/theme";
import { Button } from "./button";
import { Chips } from "./chips";
import { Body, Label } from "./text";

type Props = {
  /** The untouched image every edit starts from; null while it is being fetched. */
  source: LocalImage | null;
  /** Why the image could not be opened, when it could not. */
  loadError?: string | null;
  initial: ImageEdit;
  onCancel: () => void;
  /** Saves the edit. Resolves with a sentence when it failed, or null when the editor can close. */
  onDone: (edit: ImageEdit) => Promise<string | null>;
};

/** Full-screen image edit: centre-crop to a shape, rotate, mirror. The preview shows exactly what Done renders. */
export function MediaEditor({ source, loadError, initial, onCancel, onDone }: Props) {
  const insets = useSafeAreaInsets();
  const [edit, setEdit] = useState(initial);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unchanged = edit.shape === initial.shape && edit.turns === initial.turns && edit.flip === initial.flip;

  async function done() {
    if (unchanged) return onCancel();
    setError(null);
    setBusy(true);
    const failure = await onDone(edit);
    setBusy(false);
    if (failure) setError(failure);
  }

  let preview = null;
  if (source && box && box.width > 0 && box.height > 0) {
    const rotated = turned(source, edit.turns);
    const ratio = SHAPES.find((shape) => shape.value === edit.shape)?.ratio ?? rotated.width / rotated.height;
    const frameWidth = Math.min(box.width, box.height * ratio);
    const frameHeight = frameWidth / ratio;
    // The image covers the frame after its turn, so it is laid out unturned at that scale and then rotated in place.
    const scale = Math.max(frameWidth / rotated.width, frameHeight / rotated.height);
    const width = source.width * scale;
    const height = source.height * scale;
    preview = (
      <View style={{ width: frameWidth, height: frameHeight, overflow: "hidden" }}>
        <Image
          testID="media-edit-preview"
          accessibilityLabel="Edited image preview"
          source={{ uri: source.uri }}
          style={{
            position: "absolute",
            left: (frameWidth - width) / 2,
            top: (frameHeight - height) / 2,
            width,
            height,
            // Applied right to left: turn first, then mirror, the order the saved file uses.
            transform: [{ scaleX: edit.flip ? -1 : 1 }, { rotate: `${edit.turns * 90}deg` }],
          }}
        />
        <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, borderWidth: 2, borderColor: color.coral }} />
      </View>
    );
  }

  return (
    <Modal visible animationType="fade" statusBarTranslucent onRequestClose={() => (busy ? undefined : onCancel())}>
      <View
        testID="media-edit"
        style={{ flex: 1, backgroundColor: color.bg, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16, paddingHorizontal: 16, gap: 16 }}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
          <Button testID="media-edit-cancel" size="sm" variant="outline" label="Cancel" disabled={busy} onPress={onCancel} />
          <Button
            testID="media-edit-done"
            size="sm"
            variant="primary"
            label={busy ? "Saving" : "Done"}
            disabled={busy || !source}
            onPress={() => void done()}
          />
        </View>

        <View
          style={{ flex: 1, alignItems: "center", justifyContent: "center", opacity: busy ? 0.6 : 1 }}
          onLayout={(event) => setBox({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
        >
          {preview ?? (loadError ? <Body tone="coral">{loadError}</Body> : <Label>Opening image</Label>)}
        </View>

        {error ? (
          <Body testID="media-edit-error" tone="coral">
            {error}
          </Body>
        ) : null}

        {source ? (
          <View pointerEvents={busy ? "none" : "auto"} style={{ gap: 12 }}>
            <View style={{ gap: 8 }}>
              <Label>Shape</Label>
              <Chips options={SHAPES} value={edit.shape} onChange={(shape) => setEdit((current) => ({ ...current, shape }))} testIDPrefix="media-edit-shape" />
            </View>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <Button
                testID="media-edit-rotate"
                size="sm"
                variant="outline"
                label="Rotate"
                // The mirror comes after the turn, so a mirrored image turns the other way to look clockwise.
                onPress={() => setEdit((current) => ({ ...current, turns: (current.turns + (current.flip ? 3 : 1)) % 4 }))}
              />
              <Button
                testID="media-edit-flip"
                size="sm"
                variant="outline"
                label="Flip"
                onPress={() => setEdit((current) => ({ ...current, flip: !current.flip }))}
              />
              {!isEdited(edit) ? null : (
                <Button
                  testID="media-edit-reset"
                  size="sm"
                  variant="ghost"
                  label="Reset"
                  onPress={() => setEdit(NO_EDIT)}
                />
              )}
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}
