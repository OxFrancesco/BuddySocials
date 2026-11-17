import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { FPS, SCENES } from "./data";
import type { Layout } from "./layout";
import { LayoutContext, TopBar } from "./parts";
import { Apps } from "./scenes/Apps";
import { Board } from "./scenes/Board";
import { End } from "./scenes/End";
import { Hook } from "./scenes/Hook";
import { Inbox } from "./scenes/Inbox";
import { Posts } from "./scenes/Posts";
import { Publish } from "./scenes/Publish";
import { Sound } from "./Sound";
import { C } from "./theme";

const within = (t: number, scene: { from: number; to: number }) => t >= scene.from && t < scene.to;

// Scenes change with hard cuts, on bars of the music. Every scene reads the video's own frame.
const Picture: React.FC = () => {
  const t = useCurrentFrame() / FPS;
  return (
    <>
      {within(t, SCENES.board) ? <Board /> : null}
      {within(t, SCENES.posts) ? <Posts /> : null}
      {within(t, SCENES.publish) ? <Publish /> : null}
      {within(t, SCENES.inbox) ? <Inbox /> : null}
      {within(t, SCENES.apps) ? <Apps /> : null}
      {within(t, SCENES.end) ? <End /> : null}
      <TopBar from={SCENES.board.from} to={SCENES.end.from} />
      <Hook />
    </>
  );
};

export const Demo: React.FC<{ layout: Layout }> = ({ layout }) => (
  <AbsoluteFill style={{ background: C.bg }}>
    <LayoutContext.Provider value={layout}>
      <Picture />
    </LayoutContext.Provider>
    <Sound />
  </AbsoluteFill>
);
