import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { Sparkline } from "react-native-dither-kit";
import { api } from "../../convex/_generated/api";
import { compact, relativeTime } from "@shared/format";
import { PLATFORM_COLOR } from "@shared/platforms";
import { useHour, useNow, useToday } from "@/lib/hooks";
import { useSyncedQuery } from "@/lib/sync";
import { Byline } from "@/ui/byline";
import { GoalCard } from "@/ui/goal-card";
import { Thumb } from "@/ui/thumb";
import { Body, Figure, Label } from "@/ui/text";
import { Empty, Loading, TILE_PAD } from "./frame";
import type { WidgetBodyProps } from "./stats";

function platformArg(platform: WidgetBodyProps["config"]["platform"]) {
  return platform === "all" ? {} : { platform };
}

export function TopPostsBody({ config, height, cols }: WidgetBodyProps) {
  const hour = useHour();
  const rowHeight = 44;
  const perColumn = Math.max(1, Math.floor((height - 40) / rowHeight));
  const columns = cols >= 4 ? 2 : 1;
  const posts = useSyncedQuery(api.dashboard.topPosts, {
    since: hour - config.range * 86_400_000,
    metric: config.metric,
    limit: perColumn * columns,
    ...platformArg(config.platform),
  });
  if (posts === undefined) return <Loading />;
  if (posts.length === 0) return <Empty text="No posts in this period" />;
  const metric = config.metric === "followers" ? "views" : config.metric;
  const groups = Array.from({ length: columns }, (_, index) => posts.slice(index * perColumn, (index + 1) * perColumn));
  return (
    <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
      {groups.map((group, groupIndex) => (
        <View key={groupIndex} style={{ flex: 1 }}>
          {group.map((post, index) => (
            <Pressable
              key={post._id}
              onPress={() => router.push({ pathname: "/post/[id]", params: { id: post._id } })}
              style={({ pressed }) => ({ height: rowHeight, flexDirection: "row", alignItems: "center", gap: 10, opacity: pressed ? 0.6 : 1 })}
            >
              <Label size={11} tone="faint" style={{ width: 16 }}>
                {groupIndex * perColumn + index + 1}
              </Label>
              <Thumb seed={post._id} url={post.thumbnailUrl} size={32} />
              <View style={{ flex: 1 }}>
                <Body numberOfLines={1} style={{ fontSize: 13, lineHeight: 18 }}>
                  {post.title ?? post.text ?? "Untitled"}
                </Body>
                <Byline platform={post.platform} accountId={post.accountId} parts={[]} />
              </View>
              <Body style={{ fontSize: 13 }}>{compact(post[metric] ?? 0)}</Body>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

export function LatestPostBody({ config, rows }: WidgetBodyProps) {
  const now = useNow();
  const latest = useSyncedQuery(api.dashboard.latestPost, platformArg(config.platform));
  if (latest === undefined) return <Loading />;
  if (latest === null) return <Empty text="No posts yet" />;
  const { post, curve } = latest;
  const stats = [
    ["Views", post.views],
    ["Likes", post.likes],
    ["Comments", post.comments],
  ].filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0);
  return (
    <Pressable
      testID="latest-post"
      onPress={() => router.push({ pathname: "/post/[id]", params: { id: post._id } })}
      style={({ pressed }) => ({ flex: 1, gap: 10, opacity: pressed ? 0.7 : 1 })}
    >
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Thumb seed={post._id} url={post.thumbnailUrl} size={rows === 1 ? 40 : 56} />
        <View style={{ flex: 1, gap: 2 }}>
          <Body numberOfLines={2} style={{ fontSize: 13, lineHeight: 18 }}>
            {post.title ?? post.text ?? "Untitled"}
          </Body>
          <Byline platform={post.platform} accountId={post.accountId} parts={[relativeTime(post.publishedAt, now)]} />
        </View>
      </View>
      {rows > 1 && curve.length > 2 ? (
        <View style={{ flex: 1, marginHorizontal: -TILE_PAD }}>
          <Sparkline data={curve} color={PLATFORM_COLOR[post.platform]} variant="gradient" animate style={{ flex: 1, minHeight: 0 }} />
        </View>
      ) : null}
      <View style={{ flex: rows > 1 ? 0 : 1, flexDirection: "row", gap: 16, alignItems: "flex-end" }}>
        {stats.map(([label, value]) => (
          <View key={label} style={{ gap: 2 }}>
            <Figure size={rows === 1 ? 18 : 22}>{compact(value)}</Figure>
            <Label size={10}>{label}</Label>
          </View>
        ))}
        {rows === 1 && curve.length > 2 ? (
          // One row: the growth curve fills the space beside the numbers, out to the tile edge.
          <View style={{ flex: 1, alignSelf: "stretch", marginRight: -TILE_PAD, marginBottom: -TILE_PAD, marginTop: 4 }}>
            <Sparkline data={curve} color={PLATFORM_COLOR[post.platform]} variant="gradient" animate style={{ flex: 1, minHeight: 0 }} />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export function InboxBody({ config, rows }: WidgetBodyProps) {
  const now = useNow();
  const summary = useSyncedQuery(api.comments.openSummary, platformArg(config.platform));
  if (summary === undefined) return <Loading />;
  if (summary.count === 0) return <Empty text="All caught up" />;
  const show = rows === 1 ? 2 : 3;
  return (
    <Pressable
      testID="inbox-widget"
      onPress={() => router.navigate("/inbox")}
      style={({ pressed }) => ({ flex: 1, flexDirection: rows === 1 ? "row" : "column", gap: 16, opacity: pressed ? 0.7 : 1 })}
    >
      <View style={{ justifyContent: rows === 1 ? "flex-end" : "flex-start" }}>
        <Figure size={rows === 1 ? 34 : 40}>{summary.count >= 100 ? "99+" : summary.count}</Figure>
      </View>
      <View style={{ flex: 1, gap: 8, justifyContent: "flex-end" }}>
        {summary.latest.slice(0, show).map((comment) => (
          <View key={comment._id} style={{ gap: 2 }}>
            <Byline
              platform={comment.platform}
              accountId={comment.accountId}
              parts={[comment.authorHandle ?? comment.authorName, relativeTime(comment.publishedAt, now)]}
            />
            <Body numberOfLines={1} style={{ fontSize: 13, lineHeight: 18 }}>
              {comment.text}
            </Body>
          </View>
        ))}
      </View>
    </Pressable>
  );
}

export function GoalsBody({ height }: WidgetBodyProps) {
  const today = useToday();
  const data = useSyncedQuery(api.goals.list, { today });
  if (data === undefined) return <Loading />;
  const active = (data?.goals ?? []).filter((goal) => goal.state !== "missed");
  if (active.length === 0) return <Empty text="No goals yet" />;
  const fit = Math.max(1, Math.floor((height - 40) / 46));
  return (
    <Pressable
      testID="goals-widget"
      onPress={() => router.navigate("/goals")}
      style={({ pressed }) => ({ flex: 1, gap: 14, justifyContent: "flex-end", opacity: pressed ? 0.7 : 1 })}
    >
      {active.slice(0, fit).map((goal) => (
        <GoalCard key={goal._id} goal={goal} compactCard />
      ))}
    </Pressable>
  );
}
