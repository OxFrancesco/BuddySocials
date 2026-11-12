import { useQuery } from "convex/react";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Area, AreaChart, Tooltip, XAxis, YAxis } from "react-native-dither-kit";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { compact, durationLabel, grouped, relativeTime } from "@shared/format";
import { NATIVE_POST_METRICS } from "@shared/metrics";
import { PLATFORM_LABEL } from "@shared/platforms";
import { useNow, useWide } from "@/lib/hooks";
import { Button } from "@/ui/button";
import { CommentRow, ReplyBar } from "@/ui/comments";
import { Thumb } from "@/ui/thumb";
import { Byline } from "@/ui/byline";
import { Body, Display, Figure, Label } from "@/ui/text";
import { color } from "@/theme";

function formatNative(value: number, unit?: "seconds" | "minutes" | "percent") {
  if (unit === "seconds" || unit === "minutes") return durationLabel(value, unit);
  if (unit === "percent") return `${Math.round(value * (value <= 1 ? 100 : 1))}%`;
  return grouped(value);
}

export default function PostScreen() {
  const { id } = useLocalSearchParams<{ id: Id<"posts"> }>();
  const insets = useSafeAreaInsets();
  const wide = useWide();
  const now = useNow();
  const post = useQuery(api.dashboard.post, { postId: id });
  const comments = useQuery(api.comments.forPost, { postId: id });
  const [selectedId, setSelectedId] = useState<Id<"comments"> | null>(null);

  if (post === undefined) return <View style={{ flex: 1, backgroundColor: color.bg }} />;
  if (post === null) {
    return (
      <View style={{ flex: 1, backgroundColor: color.bg, padding: 24, paddingTop: insets.top + 24, gap: 16 }}>
        <Body>This post is no longer available.</Body>
        <Button label="Back" onPress={() => router.back()} />
      </View>
    );
  }

  const metrics = NATIVE_POST_METRICS[post.platform]
    .map((metric) => ({ ...metric, value: post.native[metric.name] }))
    .filter((metric): metric is typeof metric & { value: number } => typeof metric.value === "number" && metric.value > 0);
  const curve = post.snapshots.filter((point) => point.views !== null);
  const selected = comments?.find((comment) => comment._id === selectedId) ?? null;

  const stats = (
    <View style={{ gap: 20 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 18 }}>
        {metrics.map((metric) => (
          <View key={metric.name} style={{ width: wide ? "33%" : "50%", gap: 2, paddingRight: 8 }}>
            <Figure size={24}>{metric.unit ? formatNative(metric.value, metric.unit) : compact(metric.value)}</Figure>
            <Label size={10}>{metric.label}</Label>
          </View>
        ))}
      </View>
      {curve.length > 2 ? (
        <View style={{ gap: 8 }}>
          <Label>Views</Label>
          <AreaChart
            data={curve.map((point) => ({ at: point.at, views: point.views ?? 0 }))}
            config={{ views: { label: "Views", color: color.coral } }}
            style={{ height: 180, minHeight: 0 }}
            margins={{ top: 8, right: 4, bottom: 22, left: 40 }}
            animate
          >
            <Area dataKey="views" variant="gradient" />
            <XAxis dataKey="at" maxTicks={4} tickFormatter={(value) => relativeTime(Number(value), now)} />
            <YAxis tickCount={3} tickFormatter={compact} />
            <Tooltip labelKey="at" valueFormatter={(value) => grouped(value)} />
          </AreaChart>
        </View>
      ) : null}
    </View>
  );

  const commentList = (
    <View style={{ gap: 4 }}>
      {comments && comments.length === 0 ? <Label tone="faint">No comments yet</Label> : null}
      {comments?.map((comment) => (
        <CommentRow
          key={comment._id}
          comment={comment}
          now={now}
          showPost={false}
          selected={comment._id === selectedId}
          onSelect={() => setSelectedId(comment._id === selectedId ? null : comment._id)}
        />
      ))}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: 16, paddingBottom: 32, gap: 24 }}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Button testID="post-back" size="sm" variant="outline" label="Back" onPress={() => router.back()} />
          {post.permalink ? (
            <Button size="sm" variant="ghost" label={`Open in ${PLATFORM_LABEL[post.platform]}`} onPress={() => void WebBrowser.openBrowserAsync(post.permalink!)} />
          ) : null}
        </View>
        <View style={{ flexDirection: "row", gap: 16 }}>
          <Thumb seed={post._id} url={post.thumbnailUrl} size={wide ? 96 : 72} />
          <View style={{ flex: 1, gap: 6 }}>
            <Display size={20} numberOfLines={3}>
              {post.title ?? post.text ?? "Untitled"}
            </Display>
            <Byline
              platform={post.platform}
              accountId={post.accountId}
              parts={[relativeTime(post.publishedAt, now), `updated ${relativeTime(post.lastSyncedAt, now)}`]}
            />
          </View>
        </View>
        {wide ? (
          <View style={{ flexDirection: "row", gap: 32 }}>
            <View style={{ flex: 1 }}>{stats}</View>
            <View style={{ flex: 1 }}>{commentList}</View>
          </View>
        ) : (
          <>
            {stats}
            {commentList}
          </>
        )}
      </ScrollView>
      <ReplyBar comment={selected} onClose={() => setSelectedId(null)} />
    </View>
  );
}
