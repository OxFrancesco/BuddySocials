import type { ConfigContext, ExpoConfig } from "expo/config";
import type { WithAndroidWidgetsParams } from "react-native-android-widget";

const homeWidgets: WithAndroidWidgetsParams = {
  fonts: [
    "./assets/fonts/ChakraPetch-Bold.ttf",
    "./assets/fonts/IBMPlexMono-Regular.ttf",
    "./assets/fonts/IBMPlexMono-Bold.ttf",
  ],
  widgets: [
    {
      name: "Views",
      label: "Views",
      previewImage: "./assets/widget-preview/views.png",
      description: "Views this week with the daily trend",
      minWidth: "250dp",
      minHeight: "110dp",
      targetCellWidth: 4,
      targetCellHeight: 2,
      resizeMode: "horizontal|vertical",
      updatePeriodMillis: 1_800_000,
    },
    {
      name: "Inbox",
      label: "Inbox",
      previewImage: "./assets/widget-preview/inbox.png",
      description: "Comments waiting for a reply",
      minWidth: "250dp",
      minHeight: "110dp",
      targetCellWidth: 4,
      targetCellHeight: 2,
      resizeMode: "horizontal|vertical",
      updatePeriodMillis: 1_800_000,
    },
    {
      name: "Pulse",
      label: "Pulse",
      previewImage: "./assets/widget-preview/pulse.png",
      description: "This week's views and new followers",
      minWidth: "110dp",
      minHeight: "110dp",
      targetCellWidth: 2,
      targetCellHeight: 2,
      resizeMode: "horizontal|vertical",
      updatePeriodMillis: 1_800_000,
    },
  ],
};

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "BuddySocials",
  slug: "buddysocials",
  version: "1.0.0",
  scheme: "buddysocials",
  orientation: "default",
  icon: "./assets/icon.png",
  userInterfaceStyle: "dark",
  backgroundColor: "#000000",
  android: {
    package: "com.francescooddo.buddysocials",
    adaptiveIcon: {
      backgroundColor: "#000000",
      foregroundImage: "./assets/android-icon-foreground.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: true,
  },
  ios: { bundleIdentifier: "com.francescooddo.buddysocials", supportsTablet: true },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-web-browser",
    [
      "expo-font",
      {
        fonts: [
          "./assets/fonts/ChakraPetch-Bold.ttf",
          "./assets/fonts/IBMPlexMono-Regular.ttf",
          "./assets/fonts/IBMPlexMono-Bold.ttf",
        ],
      },
    ],
    ["expo-splash-screen", { backgroundColor: "#000000", image: "./assets/splash-icon.png", imageWidth: 72 }],
    [
      "expo-build-properties",
      {
        android: {
          buildArchs: ["arm64-v8a"],
          // R8 strips WorkManager's generated Room database, which the home screen widgets rely on.
          extraProguardRules: [
            "-keep class * extends androidx.room.RoomDatabase { <init>(); }",
            "-keep class androidx.work.impl.** { *; }",
            "-keep class com.reactnativeandroidwidget.** { *; }",
          ].join("\n"),
        },
      },
    ],
    ["react-native-android-widget", homeWidgets],
  ],
  experiments: { typedRoutes: true },
});
