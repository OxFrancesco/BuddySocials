import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useRef } from "react";
import { api } from "../../convex/_generated/api";
import { useNow } from "./hooks";

/** Longer than any real sync. Past this the claim is treated as dead, like the server does. */
const SYNC_VISIBLE_MS = 2 * 60_000;

/** True while any account is being synced. */
export function useSyncing(): boolean {
  const accounts = useQuery(api.accounts.list, {});
  const now = useNow();
  return (
    accounts?.some(
      (account) => account.status === "syncing" && account.syncStartedAt !== null && now - account.syncStartedAt < SYNC_VISIBLE_MS,
    ) ?? false
  );
}

/**
 * `useQuery` for dashboard numbers. A sync writes each account in several steps, and every
 * step would redraw every chart. This keeps the last result on screen until the sync ends,
 * so the dashboard changes once.
 */
export function useSyncedQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: Query["_args"],
): Query["_returnType"] | undefined {
  const value = useQuery(query, args) as Query["_returnType"] | undefined;
  const syncing = useSyncing();
  const key = JSON.stringify(args);
  const held = useRef<{ key: string; value: Query["_returnType"] | undefined } | null>(null);
  if (!syncing || held.current === null || held.current.key !== key || held.current.value === undefined || value === undefined) {
    held.current = { key, value };
  }
  return held.current.value;
}
