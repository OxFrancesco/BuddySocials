import { usePaginatedQuery } from "convex/react";
import { useState } from "react";
import { FlatList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PLATFORMS, PLATFORM_LABEL, type Platform } from "@shared/platforms";
import { useNow } from "@/lib/hooks";
import { Chips } from "@/ui/chips";
import { CommentRow, ReplyBar } from "@/ui/comments";
import { Body } from "@/ui/text";
import { color } from "@/theme";

type Filter = Platform | "all";

export default function Inbox() {
  const insets = useSafeAreaInsets();
  const now = useNow();
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<Id<"comments"> | null>(null);
  const { results, status, loadMore } = usePaginatedQuery(
    api.comments.list,
    { open, ...(filter === "all" ? {} : { platform: filter }) },
    { initialNumItems: 30 },
  );
  const selected = results.find((comment) => comment._id === selectedId) ?? null;

  return (
    <View style={{ flex: 1, backgroundColor: color.bg, paddingTop: insets.top + 12 }}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 10 }}>
        <Chips
          testIDPrefix="inbox-state"
          options={[
            { value: "open", label: "Waiting" },
            { value: "all", label: "All" },
          ]}
          value={open ? "open" : "all"}
          onChange={(value) => setOpen(value === "open")}
        />
        <Chips
          scroll
          testIDPrefix="inbox-platform"
          options={[{ value: "all" as Filter, label: "All" }, ...PLATFORMS.map((p) => ({ value: p as Filter, label: PLATFORM_LABEL[p] }))]}
          value={filter}
          onChange={setFilter}
        />
      </View>
      <FlatList
        data={results}
        keyExtractor={(comment) => comment._id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <CommentRow
            comment={item}
            now={now}
            showPost
            selected={item._id === selectedId}
            onSelect={() => setSelectedId(item._id === selectedId ? null : item._id)}
          />
        )}
        onEndReached={() => {
          if (status === "CanLoadMore") loadMore(30);
        }}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          status === "LoadingFirstPage" ? undefined : (
            <Body tone="dim" style={{ paddingTop: 24 }}>
              {open ? "Nothing waiting for a reply." : "No comments yet."}
            </Body>
          )
        }
      />
      <ReplyBar comment={selected} onClose={() => setSelectedId(null)} />
    </View>
  );
}
