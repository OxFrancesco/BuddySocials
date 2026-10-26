import type { WidgetTaskHandlerProps } from "react-native-android-widget";
import { loadSnapshot, type HomeSnapshot } from "./snapshot";
import {
  GoalsWidget,
  InboxWidget,
  LatestPostWidget,
  MixWidget,
  PlatformsWidget,
  PulseWidget,
  SetupWidget,
  ViewsWidget,
} from "./widgets";

/** Names match `widgets[].name` in app.config.ts. */
export const HOME_WIDGETS = ["Views", "Mix", "Pulse", "Platforms", "Goals", "Inbox", "LatestPost"] as const;

const RENDERERS = {
  Views: ViewsWidget,
  Mix: MixWidget,
  Pulse: PulseWidget,
  Platforms: PlatformsWidget,
  Goals: GoalsWidget,
  Inbox: InboxWidget,
  LatestPost: LatestPostWidget,
} as const;

export function renderHomeWidget(name: string, size: { width: number; height: number }, snapshot: HomeSnapshot | null) {
  if (snapshot === null) return <SetupWidget {...size} />;
  const Widget = RENDERERS[name as keyof typeof RENDERERS] ?? ViewsWidget;
  return <Widget {...size} snapshot={snapshot} />;
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
