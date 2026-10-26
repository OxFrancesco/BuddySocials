import { useSSO } from "@clerk/expo";
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/ui/button";
import { Body, Display } from "@/ui/text";
import { color } from "@/theme";

WebBrowser.maybeCompleteAuthSession();

export default function SignIn() {
  const insets = useSafeAreaInsets();
  const { startSSOFlow } = useSSO();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Warming the browser makes the Google sheet open instantly on Android.
  useEffect(() => {
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: "oauth_google",
        redirectUrl: AuthSession.makeRedirectUri({ scheme: "buddysocials", path: "sso-callback" }),
      });
      if (createdSessionId && setActive) await setActive({ session: createdSessionId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Google sign-in did not finish.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: color.bg,
        paddingTop: insets.top + 24,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 24,
        justifyContent: "space-between",
      }}
    >
      <Display size={44}>Buddy{"\n"}Socials</Display>
      <View style={{ gap: 16 }}>
        {error ? <Body tone="coral">{error}</Body> : null}
        <Button testID="google-sign-in" label={busy ? "Opening Google" : "Continue with Google"} onPress={signIn} disabled={busy} />
      </View>
    </View>
  );
}
