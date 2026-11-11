import { useQuery } from "convex/react";
import { useMemo } from "react";
import { View } from "react-native";
import { api } from "../../convex/_generated/api";
import type { Platform } from "@shared/platforms";
import { color } from "@/theme";
import { PlatformLogo } from "./platform-logo";
import { Label } from "./text";

/** Handles keyed by account, only for platforms with more than one account. With one, the logo already says whose it is. */
export function useAccountHandles(): ReadonlyMap<string, string> {
  const accounts = useQuery(api.accounts.list, {});
  return useMemo(() => {
    const perPlatform = new Map<string, number>();
    for (const account of accounts ?? []) perPlatform.set(account.platform, (perPlatform.get(account.platform) ?? 0) + 1);
    return new Map(
      (accounts ?? []).filter((account) => (perPlatform.get(account.platform) ?? 0) > 1).map((account) => [account._id as string, account.handle]),
    );
  }, [accounts]);
}

/** Platform logo, then the account when it's ambiguous, then whatever follows: author, age. */
export function Byline({ platform, accountId, parts, size = 10 }: { platform: Platform; accountId?: string; parts: (string | null)[]; size?: number }) {
  const handles = useAccountHandles();
  const handle = accountId ? handles.get(accountId) : undefined;
  const text = [handle ?? null, ...parts].filter(Boolean).join(" · ");
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <PlatformLogo platform={platform} size={size + 1} tint={color.fg} opacity={0.7} />
      {text ? (
        <Label size={size} numberOfLines={1} style={{ flexShrink: 1 }}>
          {text}
        </Label>
      ) : null}
    </View>
  );
}
