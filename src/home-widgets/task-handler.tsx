import type { WidgetTaskHandlerProps } from "react-native-android-widget";
import { loadSnapshot, type HomeSnapshot } from "./snapshot";
import { InboxWidget, PulseWidget, SetupWidget, ViewsWidget } from "./widgets";

export const HOME_WIDGETS = ["Views", "Inbox", "Pulse"] as const;

export function renderHomeWidget(name: string, size: { width: number; height: number }, snapshot: HomeSnapshot | null) {
  if (snapshot === null) return <SetupWidget {...size} />;
  switch (name) {
    case "Inbox":
      return <InboxWidget {...size} snapshot={snapshot} />;
    case "Pulse":
      return <PulseWidget {...size} snapshot={snapshot} />;
    default:
      return <ViewsWidget {...size} snapshot={snapshot} />;
  }
}

/** Runs headless when Android adds, resizes or refreshes a widget (every 30 minutes). */
export async function widgetTaskHandler(props: WidgetTaskHandlerProps) {
  const { widgetInfo } = props;
  switch (props.widgetAction) {
    case "WIDGET_ADDED":
    case "WIDGET_UPDATE":
    case "WIDGET_RESIZED": {
      const snapshot = await loadSnapshot();
      props.renderWidget(renderHomeWidget(widgetInfo.widgetName, widgetInfo, snapshot));
      break;
    }
    default:
      break;
  }
}
