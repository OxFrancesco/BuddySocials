import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import type { Platform } from "@shared/platforms";
import { convexSiteUrl } from "@/lib/config";

export type HomeSnapshot = {
  today: string;
  since: string;
  /** Views per day for the last 14 days, all platforms. */
  daily: number[];
  week: number;
  previousWeek: number;
  newFollowers: number;
  followersTotal: number;
  engagement: number;
  perPlatform: {
    platform: Platform;
    views: number;
    previousViews: number;
    engagement: number;
    newFollowers: number;
    followers: number | null;
    daily: number[];
  }[];
  goals: {
    id: string;
    title: string;
    value: number;
    target: number;
    progress: number;
    pace: number;
    state: "done" | "ahead" | "behind" | "missed" | "upcoming";
    daysLeft: number;
    streak: number;
  }[];
  latestPost: {
    id: string;
    platform: Platform;
    title: string;
    publishedAt: number;
    views: number | null;
    likes: number | null;
    comments: number | null;
    curve: number[];
  } | null;
  openCount: number;
  latest: { id: string; platform: Platform; author: string; text: string; publishedAt: number }[];
};

const TOKEN_KEY = "home-widget-token";
const CACHE_KEY = "home-widget-snapshot";

export async function getWidgetToken(): Promise<string | null> {
  return await SecureStore.getItemAsync(TOKEN_KEY);
}

export async function setWidgetToken(token: string | null): Promise<void> {
  if (token === null) await SecureStore.deleteItemAsync(TOKEN_KEY);
  else await SecureStore.setItemAsync(TOKEN_KEY, token);
}

/** Fills fields an older app version may not have cached. */
function withDefaults(snapshot: HomeSnapshot): HomeSnapshot {
  return {
    ...snapshot,
    followersTotal: snapshot.followersTotal ?? 0,
    engagement: snapshot.engagement ?? 0,
    goals: snapshot.goals ?? [],
    latestPost: snapshot.latestPost ?? null,
    perPlatform: (snapshot.perPlatform ?? []).map((entry) => ({
      ...entry,
      previousViews: entry.previousViews ?? 0,
      newFollowers: entry.newFollowers ?? 0,
      daily: entry.daily ?? [],
    })),
  };
}

export async function cachedSnapshot(): Promise<HomeSnapshot | null> {
  const raw = await AsyncStorage.getItem(CACHE_KEY);
  return raw ? withDefaults(JSON.parse(raw) as HomeSnapshot) : null;
}

/** Fetches a fresh snapshot with the widget token, falling back to the last good one. */
export async function loadSnapshot(): Promise<HomeSnapshot | null> {
  const token = await getWidgetToken();
  if (!token || !convexSiteUrl) return await cachedSnapshot();
  try {
    const response = await fetch(`${convexSiteUrl}/widget-snapshot`, { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 401) {
      await setWidgetToken(null);
      return null;
    }
    if (!response.ok) return await cachedSnapshot();
    const snapshot = withDefaults((await response.json()) as HomeSnapshot);
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
    return snapshot;
  } catch {
    return await cachedSnapshot();
  }
}
