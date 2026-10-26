import { useConvexAuth } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

// When the app returns to the foreground the network may not be ready yet:
// getToken fails, Convex marks the session expired and never retries until
// Clerk changes session, so queries stall until restart. This retries the
// token and, if Convex stays unauthenticated, re-runs setAuth.
// Adapted from Lamentos.
const TOKEN_RETRY_DELAYS_MS = [500, 1500, 4000];
const RECOVERY_MAX_DELAY_MS = 30_000;

type ClerkAuth = {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  getToken: (options: { template?: string; skipCache?: boolean }) => Promise<string | null>;
  orgId?: string | null;
  orgRole?: string | null;
  sessionId?: string | null;
  sessionClaims?: object | null;
};

type SubscribeResume = (onResume: () => void) => () => void;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Replaces `ConvexProviderWithClerk`: pass `useAuthForConvex` to
 * `ConvexProviderWithAuth` and mount `ConvexAuthRecovery` inside it.
 */
export function createConvexClerkAuth(useClerkAuth: () => ClerkAuth, subscribeResume: SubscribeResume) {
  let epoch = 0;
  const listeners = new Set<() => void>();
  const subscribeEpoch = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const getEpoch = () => epoch;
  const bumpEpoch = () => {
    epoch += 1;
    for (const listener of listeners) listener();
  };

  function useAuthForConvex() {
    const { isLoaded, isSignedIn, getToken, orgId, orgRole, sessionId, sessionClaims } = useClerkAuth();
    const authEpoch = useSyncExternalStore(subscribeEpoch, getEpoch, getEpoch);
    // With Clerk"s native Convex integration the session token already targets Convex.
    const audience = (sessionClaims as { aud?: unknown } | null | undefined)?.aud;
    const template = audience === "convex" ? undefined : "convex";
    // Clerk Expo"s getToken changes every render, so read it from a ref.
    const getTokenRef = useRef(getToken);
    useEffect(() => {
      getTokenRef.current = getToken;
    }, [getToken]);

    const fetchAccessToken = useCallback(
      async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            return await getTokenRef.current({ template, skipCache: forceRefreshToken });
          } catch (error) {
            // A Clerk 4xx won"t improve with retries; network errors and 5xx might.
            const status = (error as { status?: unknown } | null)?.status;
            if (typeof status === "number" && status < 500) return null;
            const delay = TOKEN_RETRY_DELAYS_MS[attempt];
            if (delay === undefined) return null;
            await wait(delay);
          }
        }
      },
      // A new function identity restarts setAuth; authEpoch exists for that.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [orgId, orgRole, sessionId, template, authEpoch],
    );

    return useMemo(
      () => ({ isLoading: !isLoaded, isAuthenticated: isSignedIn ?? false, fetchAccessToken }),
      [isLoaded, isSignedIn, fetchAccessToken],
    );
  }

  /** If Clerk is signed in but Convex is not, retry with backoff and immediately on resume. */
  function ConvexAuthRecovery() {
    const { isSignedIn } = useClerkAuth();
    const { isLoading, isAuthenticated } = useConvexAuth();
    const stranded = isSignedIn === true && !isLoading && !isAuthenticated;
    const attempts = useRef(0);

    useEffect(() => {
      if (isAuthenticated) attempts.current = 0;
    }, [isAuthenticated]);

    useEffect(() => {
      if (!stranded) return;
      const delay = Math.min(RECOVERY_MAX_DELAY_MS, 1000 * 2 ** attempts.current);
      attempts.current += 1;
      const timer = setTimeout(bumpEpoch, delay);
      const unsubscribe = subscribeResume(bumpEpoch);
      return () => {
        clearTimeout(timer);
        unsubscribe();
      };
    }, [stranded]);

    return null;
  }

  return { useAuthForConvex, ConvexAuthRecovery };
}
