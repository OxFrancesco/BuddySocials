import { usePaginatedQuery } from "convex/react";
import { useState } from "react";
import { FlatList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../../convex/_generated/api";
import type { Platform } from "@shared/platforms";
import { useNow, useWide } from "@/lib/hooks";
import { Chips, platformOptions } from "@/ui/chips";
import { PostRow } from "@/ui/post-row";
import { Body } from "@/ui/text";
import { color } from "@/theme";

type Filter = Platform | "all";

export default function Posts() {
  const insets = useSafeAreaInsets();
  const wide = useWide();
  const now = useNow();
  const [filter, setFilter] = useState<Filter>("all");
  const { results, status, loadMore } = usePaginatedQuery(
    api.dashboard.posts,
    filter === "all" ? {} : { platform: filter },
    { initialNumItems: 30 },
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.bg, paddingTop: insets.top + 12 }}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <Chips
          scroll
          testIDPrefix="posts-filter"
          options={platformOptions()}
          value={filter}
          onChange={setFilter}
        />
      </View>
      <FlatList
        key={wide ? "wide" : "narrow"}
        data={results}
        numColumns={wide ? 2 : 1}
        columnWrapperStyle={wide ? { gap: 24 } : undefined}
        keyExtractor={(post) => post._id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        renderItem={({ item }) => (
          <View style={{ flex: 1 }}>
            <PostRow post={item} now={now} />
          </View>
        )}
        onEndReached={() => {
          if (status === "CanLoadMore") loadMore(30);
        }}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          status === "LoadingFirstPage" ? undefined : (
            <Body tone="dim" style={{ paddingTop: 24 }}>
              No posts yet.
            </Body>
          )
        }
      />
    </View>
  );
}
