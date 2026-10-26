import { useMutation } from "convex/react";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { relativeTime } from "@shared/format";
import { PLATFORM_TAG, type Platform } from "@shared/platforms";
import { color, font } from "@/theme";
import { Button } from "./button";
import { Body, Label } from "./text";

export type CommentItem = {
  _id: Id<"comments">;
  platform: Platform;
  authorName: string;
  authorHandle: string | null;
  text: string;
  publishedAt: number;
  likeCount: number | null;
  state: "open" | "replied" | "done";
  reply: { text: string; at: number; status: "sending" | "sent" | "failed"; error?: string } | null;
  postTitle: string | null;
};

function author(comment: CommentItem) {
  return comment.authorHandle ? `@${comment.authorHandle.replace(/^@/, "")}` : comment.authorName;
}

export function CommentRow({
  comment,
  now,
  selected,
  showPost,
  onSelect,
}: {
  comment: CommentItem;
  now: number;
  selected: boolean;
  showPost: boolean;
  onSelect: () => void;
}) {
  return (
    <Pressable
      testID={`comment-${comment._id}`}
      onPress={onSelect}
      style={{
        paddingVertical: 14,
        paddingHorizontal: 12,
        marginHorizontal: -12,
        gap: 6,
        borderLeftWidth: 3,
        borderLeftColor: selected ? color.coral : "transparent",
        borderBottomWidth: 1,
        borderBottomColor: color.line,
        opacity: comment.state === "done" ? 0.6 : 1,
      }}
    >
      <Label size={10} numberOfLines={1}>
        {PLATFORM_TAG[comment.platform]} · {author(comment)} · {relativeTime(comment.publishedAt, now)}
      </Label>
      <Body>{comment.text}</Body>
      {showPost && comment.postTitle ? (
        <Body tone="faint" numberOfLines={1} style={{ fontSize: 12, lineHeight: 18 }}>
          On: {comment.postTitle}
        </Body>
      ) : null}
      {comment.reply ? (
        <View style={{ borderLeftWidth: 2, borderLeftColor: comment.reply.status === "failed" ? color.coral : color.line, paddingLeft: 10, gap: 2 }}>
          <Label size={10} tone={comment.reply.status === "failed" ? "coral" : "dim"}>
            {comment.reply.status === "sending"
              ? "Sending"
              : comment.reply.status === "failed"
                ? `Not sent · ${comment.reply.error ?? "try again"}`
                : `You replied · ${relativeTime(comment.reply.at, now)}`}
          </Label>
          <Body tone="dim" style={{ fontSize: 13, lineHeight: 19 }}>
            {comment.reply.text}
          </Body>
        </View>
      ) : null}
    </Pressable>
  );
}

/** Sticks to the keyboard. Appears when a comment is selected. */
export function ReplyBar({ comment, onClose }: { comment: CommentItem | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const reply = useMutation(api.comments.reply);
  const setDone = useMutation(api.comments.setDone);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);

  useEffect(() => {
    setText(comment?.reply?.status === "failed" ? comment.reply.text : "");
    setError(null);
    if (comment) setTimeout(() => input.current?.focus(), 50);
  }, [comment?._id]);

  if (!comment) return null;
  const canDone = comment.state === "open" && (comment.reply === null || comment.reply.status === "failed");

  async function send() {
    if (!comment) return;
    try {
      await reply({ commentId: comment._id, text });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setText("");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^.*Uncaught Error: /, "").split("\n")[0]! : "Reply failed.");
    }
  }

  return (
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
      <View style={{ borderTopWidth: 2, borderTopColor: color.line, backgroundColor: color.bg, padding: 12, gap: 10 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Label size={10} numberOfLines={1} style={{ flex: 1 }}>
            Replying to {author(comment)} on {PLATFORM_TAG[comment.platform]}
          </Label>
          <View style={{ flexDirection: "row", gap: 4 }}>
            {canDone ? (
              <Button
                testID="mark-done"
                size="sm"
                variant="ghost"
                label="Mark done"
                onPress={() => {
                  void setDone({ commentId: comment._id, done: true });
                  onClose();
                }}
              />
            ) : null}
            <Button testID="close-reply" size="sm" variant="ghost" label="Close" onPress={onClose} />
          </View>
        </View>
        {error ? (
          <Body tone="coral" style={{ fontSize: 12 }}>
            {error}
          </Body>
        ) : null}
        <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
          <TextInput
            ref={input}
            testID="reply-input"
            value={text}
            onChangeText={setText}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Write a reply"
            placeholderTextColor="rgba(255,255,255,0.6)"
            multiline
            maxLength={2000}
            style={{
              flex: 1,
              minHeight: 44,
              maxHeight: 120,
              borderWidth: 2,
              borderColor: focused ? color.coral : color.line,
              color: color.fg,
              fontFamily: font.mono,
              fontSize: 14,
              paddingHorizontal: 12,
              paddingVertical: 10,
            }}
          />
          <Button testID="send-reply" variant="primary" label="Send" onPress={send} disabled={text.trim().length === 0} />
        </View>
      </View>
    </KeyboardStickyView>
  );
}
