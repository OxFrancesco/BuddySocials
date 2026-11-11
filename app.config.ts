import type { ConfigContext, ExpoConfig } from "expo/config";
import type { WithAndroidWidgetsParams } from "react-native-android-widget";

type HomeWidget = WithAndroidWidgetsParams["widgets"][number];

const W = (name: string, label: string, description: string, cols: number, rows: number, preview: string): HomeWidget => ({
  name,
  label,
  description,
  minWidth: "110dp",
  minHeight: "50dp",
  targetCellWidth: cols,
  targetCellHeight: rows,
  maxResizeWidth: "900dp",
  maxResizeHeight: "900dp",
  resizeMode: "horizontal|vertical",
  updatePeriodMillis: 1_800_000,
  previewImage: `./assets/widget-preview/${preview}.png`,
});

const homeWidgets: WithAndroidWidgetsParams = {
  fonts: [
    "./assets/fonts/ChakraPetch-Bold.ttf",
    "./assets/fonts/IBMPlexMono-Regular.ttf",
    "./assets/fonts/IBMPlexMono-Bold.ttf",
  ],
  widgets: [
    // Every widget resizes from 2x1 up; each one lays itself out for its current size.
    W("Views", "Views", "Views this week with the daily trend", 4, 2, "views"),
    W("Mix", "Platform mix", "Daily views with each platform in its own colour", 4, 2, "mix"),
    W("Pulse", "Pulse", "Views, interactions and new followers this week", 2, 2, "pulse"),
    W("Platforms", "Platforms", "Views by platform with the change from last week", 4, 2, "platforms"),
    W("Goals", "Goals", "Progress on your goals", 4, 2, "goals"),
    W("Inbox", "Inbox", "Comments waiting for a reply", 4, 2, "inbox"),
    W("LatestPost", "Latest post", "Your newest post and how it is doing", 4, 2, "latest-post"),
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
      "expo-image-picker",
      {
        photosPermission: "BuddySocials attaches the photos and videos you choose to your posts.",
        cameraPermission: "BuddySocials uses the camera to take photos and videos for your posts.",
        microphonePermission: "BuddySocials records sound with the videos you take for your posts.",
      },
    ],
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
          // WorkManager builds its database, workers and input mergers by reflection; R8 must keep them
          // or background widget renders (resize, scheduled refresh) silently fail.
          extraProguardRules: [
            "-keep class * extends androidx.room.RoomDatabase { <init>(); }",
            "-keep class androidx.work.** { *; }",
            "-keep class * extends androidx.work.ListenableWorker { public <init>(android.content.Context, androidx.work.WorkerParameters); }",
            "-keep class * extends androidx.work.InputMerger { public <init>(); }",
            "-keep class com.reactnativeandroidwidget.** { *; }",
          ].join("\n"),
        },
      },
    ],
    ["react-native-android-widget", homeWidgets],
  ],
  experiments: { typedRoutes: true },
});
