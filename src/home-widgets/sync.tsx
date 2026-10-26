import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { requestWidgetUpdate } from "react-native-android-widget";
import { api } from "../../convex/_generated/api";
import { getWidgetToken, loadSnapshot, setWidgetToken } from "./snapshot";
import { HOME_WIDGETS, renderHomeWidget } from "./task-handler";

async function refreshAll() {
  const snapshot = await loadSnapshot();
  for (const widgetName of HOME_WIDGETS) {
    await requestWidgetUpdate({
      widgetName,
      renderWidget: (info) => renderHomeWidget(widgetName, info, snapshot),
      widgetNotFound: () => {},
    });
  }
}

/**
 * Keeps the Android home screen widgets in step with the app: issues the
 * read-only widget token once, then redraws the widgets whenever the
 * dashboard data changes or the app comes back to the foreground.
 */
export function HomeWidgetSync() {
  const { isAuthenticated } = useConvexAuth();
  const issueToken = useMutation(api.homeWidgets.issueToken);
  const accounts = useQuery(api.accounts.list, isAuthenticated ? {} : "skip");
  const open = useQuery(api.comments.openSummary, isAuthenticated ? {} : "skip");
  const issuing = useRef(false);

  useEffect(() => {
    if (Platform.OS !== "android" || !isAuthenticated || issuing.current) return;
    issuing.current = true;
    void (async () => {
      if (!(await getWidgetToken())) await setWidgetToken(await issueToken({}));
      await refreshAll();
    })().finally(() => {
      issuing.current = false;
    });
  }, [isAuthenticated, issueToken]);

  const lastSync = accounts?.reduce((max, account) => Math.max(max, account.lastSyncedAt ?? 0), 0);
  useEffect(() => {
    if (Platform.OS !== "android" || !isAuthenticated || lastSync === undefined) return;
    void refreshAll();
  }, [isAuthenticated, lastSync, open?.count]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") void refreshAll();
    });
    return () => subscription.remove();
  }, []);

  return null;
}
