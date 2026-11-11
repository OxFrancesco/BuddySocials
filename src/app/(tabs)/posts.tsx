import { usePaginatedQuery, useQuery } from "convex/react";
import { router } from "expo-router";
import { useState } from "react";
import { FlatList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../../convex/_generated/api";
import type { Platform } from "@shared/platforms";
import { useNow, useWide } from "@/lib/hooks";
import { Button } from "@/ui/button";
import { Chips, platformOptions } from "@/ui/chips";
import { DraftRow } from "@/ui/draft-row";
import { PlusButton } from "@/ui/plus";
import { PostRow } from "@/ui/post-row";
import { Body } from "@/ui/text";
import { color } from "@/theme";

type Filter = Platform | "all";
type Mode = "published" | "drafts";

export default function Posts() {
  const insets = useSafeAreaInsets();
  const wide = useWide();
  const now = useNow();
  const [view, setView] = useState<Mode>("published");
  const [filter, setFilter] = useState<Filter>("all");
  // Both lists stay subscribed and mounted, so switching between them never waits on a load.
  const { results, status, loadMore } = usePaginatedQuery(
    api.dashboard.posts,
    filter === "all" ? {} : { platform: filter },
    { initialNumItems: 30 },
  );
  const drafts = useQuery(api.drafts.list, {});

  const openDraft = (id: string) => router.push({ pathname: "/draft/[id]", params: { id } });
  const noDrafts = view === "drafts" && drafts !== undefined && drafts.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: color.bg, paddingTop: insets.top + 12 }}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 10 }}>
        <Chips
          testIDPrefix="posts-view"
          options={[
            { value: "published", label: "Published" },
            { value: "drafts", label: "Drafts" },
          ]}
          value={view}
          onChange={setView}
        />
        {view === "published" ? (
          <Chips scroll testIDPrefix="posts-filter" options={platformOptions()} value={filter} onChange={setFilter} />
        ) : null}
      </View>
      <FlatList
        key={wide ? "wide" : "narrow"}
        testID="posts-list"
        style={{ display: view === "published" ? "flex" : "none" }}
        data={results}
        numColumns={wide ? 2 : 1}
        columnWrapperStyle={wide ? { gap: 24 } : undefined}
        keyExtractor={(post) => post._id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
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
      <FlatList
        testID="drafts-list"
        style={{ display: view === "drafts" ? "flex" : "none" }}
        data={drafts ?? []}
        keyExtractor={(draft) => draft._id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
        renderItem={({ item }) => <DraftRow draft={item} onPress={() => openDraft(item._id)} />}
        ListEmptyComponent={
          drafts === undefined ? undefined : (
            <View style={{ paddingTop: 24, alignItems: "flex-start" }}>
              <Button testID="write-draft" variant="primary" label="Write a draft" onPress={() => openDraft("new")} />
            </View>
          )
        }
      />
      {noDrafts ? null : (
        <PlusButton
          testID="add-draft"
          accessibilityLabel="New draft"
          onPress={() => {
            setView("drafts");
            openDraft("new");
          }}
          style={{ position: "absolute", right: 16, bottom: 16 }}
        />
      )}
    </View>
  );
}
