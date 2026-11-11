import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect, useMemo } from "react";
import { AppState, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { ChartThemeProvider } from "react-native-dither-kit";
import { createConvexClerkAuth } from "@/lib/convex-clerk-auth";
import { clerkPublishableKey, convexUrl } from "@/lib/config";
import { HomeWidgetSync } from "@/home-widgets/sync";
import { Body } from "@/ui/text";
import { color, font } from "@/theme";

void SplashScreen.preventAutoHideAsync();
void SystemUI.setBackgroundColorAsync(color.bg);

const { useAuthForConvex, ConvexAuthRecovery } = createConvexClerkAuth(useAuth, (onResume) => {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") onResume();
  });
  return () => subscription.remove();
});

const chartTheme = {
  foreground: color.fg,
  muted: "rgba(255,255,255,0.6)",
  card: color.bg,
  border: color.line,
  borderActive: color.fg,
  popover: color.bg,
  popoverBorder: color.fg,
  popoverFrosted: color.bg,
  popoverFrostedBorder: color.fg,
  fontFamily: font.mono,
};

export default function RootLayout() {
  const convex = useMemo(() => (convexUrl ? new ConvexReactClient(convexUrl) : null), []);

  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  if (!clerkPublishableKey || !convex) {
    return (
      <View style={{ flex: 1, backgroundColor: color.bg, justifyContent: "center", padding: 24 }}>
        <Body>Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY or EXPO_PUBLIC_CONVEX_URL.</Body>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: color.bg }}>
      <StatusBar style="light" />
      <KeyboardProvider>
      <ClerkProvider publishableKey={clerkPublishableKey} tokenCache={tokenCache}>
        <ConvexProviderWithAuth client={convex} useAuth={useAuthForConvex}>
          <ConvexAuthRecovery />
          <ChartThemeProvider theme={chartTheme}>
            <Navigator />
          </ChartThemeProvider>
        </ConvexProviderWithAuth>
      </ClerkProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

function Navigator() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <View style={{ flex: 1, backgroundColor: color.bg }} />;
  const signedIn = isSignedIn === true;
  return (
    <>
      {signedIn ? <HomeWidgetSync /> : null}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg }, animation: "default" }}>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="post/[id]" />
          <Stack.Screen
            name="widget/[id]"
            options={{ presentation: "formSheet", sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true, contentStyle: { backgroundColor: color.bg, borderTopWidth: 3, borderTopColor: color.fg } }}
          />
          <Stack.Screen
            name="add-account"
            options={{ presentation: "formSheet", sheetAllowedDetents: "fitToContents", sheetGrabberVisible: true, contentStyle: { backgroundColor: color.bg } }}
          />
          <Stack.Screen name="add-widget" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
          <Stack.Screen name="goal/[id]" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
          <Stack.Screen name="draft/[id]" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
        <Stack.Screen name="sso-callback" />
      </Stack>
    </>
  );
}
