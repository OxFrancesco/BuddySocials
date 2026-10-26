import { Redirect } from "expo-router";

/** Clerk's OAuth redirect lands here; the session is already set, so continue home. */
export default function SSOCallback() {
  return <Redirect href="/" />;
}
