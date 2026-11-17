import React from "react";
import { useCurrentFrame } from "remotion";
import { CUE, FPS, PLATFORMS, SCENES } from "../data";
import { easeInOut, ramp, track } from "../motion";
import { AppWindow, PlatformChips, Shot, useLayout, useZoom } from "../parts";
import { C } from "../theme";

const CaughtUp: React.FC = () => {
  const frame = useCurrentFrame();
  const k = useZoom();
  return <div style={{ position: "absolute", left: 400, top: 128, width: 260, height: 64, boxSizing: "border-box", border: `${3 / k}px solid ${C.coral}`, opacity: ramp(frame, CUE.caughtUp, 0.2) }} />;
};

/** The inbox (empty today: all caught up), then the goals with their pace marks. */
export const Inbox: React.FC = () => {
  const L = useLayout();
  const frame = useCurrentFrame();
  const t = frame / FPS;
  if (t < CUE.goals) {
    return (
      <>
        <AppWindow win={L.inbox.win} cam={track(frame, L.inbox.cam, 0.7, easeInOut)}>
          <Shot name="inbox" />
          <CaughtUp />
        </AppWindow>
        <PlatformChips from={SCENES.inbox.from} to={CUE.goals} litAt={PLATFORMS.map((_, i) => CUE.everyPlatform + i * 0.09)} enter={0.01} />
      </>
    );
  }
  const wipe = ramp(frame, CUE.goals + 0.1, 0.8, easeInOut);
  return (
    <AppWindow win={L.inbox.goalsWin} cam={track(frame, L.inbox.goalsCam)}>
      {/* Captured from the app at its narrowest window, so the whole row fits and reads. */}
      <Shot name="goals" width={2580} height={1680} style={{ clipPath: `inset(0 ${(1 - wipe) * 78}% 0 0)` }} />
    </AppWindow>
  );
};
