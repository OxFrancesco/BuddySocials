import { useAction, useQuery } from "convex/react";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { useState, useSyncExternalStore } from "react";
import { api } from "../../convex/_generated/api";
import { PLATFORM_LABEL, type Platform } from "@shared/platforms";

export type Notice = { text: string; error: boolean };

/** One notice shared by the Accounts screen and the add sheet, so a result survives the sheet closing. */
let current: Notice | null = null;
const listeners = new Set<() => void>();

export function setNotice(next: Notice | null) {
  current = next;
  for (const listener of listeners) listener();
}

export function useNotice(): Notice | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message.split("\n")[0]!.replace(/^.*Uncaught Error: /, "") : "Could not start sign-in.";
}

/** What the callback put in the return URL, turned into a sentence. */
export function noticeFor(params: Record<string, unknown>, intent: "add" | "reconnect"): Notice | null {
  const text = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : null);
  const error = text("error");
  if (error) return { text: error, error: true };
  const platform = text("connected") as Platform | null;
  if (!platform || !(platform in PLATFORM_LABEL)) return null;
  const handle = text("handle") ?? PLATFORM_LABEL[platform];
  if (text("existing") && intent === "add") {
    return {
      text: `${handle} is already connected. To add a different account, sign out of ${PLATFORM_LABEL[platform]} in your browser first.`,
      error: true,
    };
  }
  return { text: `${handle} connected.`, error: false };
}

/**
 * Opens the platform's sign-in and reports the outcome. When the platform
 * already has an account, it asks the platform for its account picker so the
 * browser's current session doesn't sign the same account in twice.
 */
export function useConnect() {
  const begin = useAction(api.connect.begin);
  const accounts = useQuery(api.accounts.list, {});
  const [busy, setBusy] = useState<Platform | null>(null);

  /** Resolves false only when the person backed out of the sign-in. */
  async function connect(platform: Platform, intent: "add" | "reconnect", options: { pages?: boolean } = {}): Promise<boolean> {
    setBusy(platform);
    setNotice(null);
    const direct = (accounts ?? []).filter((account) => account.platform === platform && account.source === "direct").length;
    try {
      const url = await begin(
        options.pages ? { platform, pages: true } : { platform, another: direct > (intent === "reconnect" ? 1 : 0) },
      );
      const result = await WebBrowser.openAuthSessionAsync(url, "buddysocials://accounts");
      if (result.type !== "success") return false;
      setNotice(noticeFor(Linking.parse(result.url).queryParams ?? {}, intent));
      return true;
    } catch (cause) {
      setNotice({ text: errorText(cause), error: true });
      return true;
    } finally {
      setBusy(null);
    }
  }

  return { connect, busy };
}
