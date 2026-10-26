import { router } from "expo-router";
import { Pressable, View } from "react-native";
import type { PostSummary } from "../../convex/dashboard";
import { compact, relativeTime } from "@shared/format";
import { PLATFORM_LABEL } from "@shared/platforms";
import { color } from "@/theme";
import { Body, Label } from "./text";
import { Thumb } from "./thumb";

export function PostRow({ post, now }: { post: PostSummary; now: number }) {
  const stats = (
    [
      ["views", post.views],
      ["likes", post.likes],
      ["comments", post.comments],
      ["shares", post.shares],
    ] as const
  ).filter(([, value]) => typeof value === "number" && value > 0);
  return (
    <Pressable
      testID={`post-${post._id}`}
      onPress={() => router.push({ pathname: "/post/[id]", params: { id: post._id } })}
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: 12,
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: color.line,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Thumb seed={post._id} url={post.thumbnailUrl} size={56} />
      <View style={{ flex: 1, gap: 4 }}>
        <Body numberOfLines={2} style={{ fontSize: 13, lineHeight: 19 }}>
          {post.title ?? post.text ?? "Untitled"}
        </Body>
        <Label size={10}>
          {PLATFORM_LABEL[post.platform]} · {relativeTime(post.publishedAt, now)}
        </Label>
        {stats.length > 0 ? (
          <View style={{ flexDirection: "row", gap: 14, marginTop: 2 }}>
            {stats.map(([name, value]) => (
              <Label key={name} size={10} tone="fg">
                {compact(value as number)} {name}
              </Label>
            ))}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
