import React from "react";
import { Composition } from "remotion";
import { DURATION, f, FPS } from "./data";
import { Demo } from "./Demo";
import { LANDSCAPE, VERTICAL } from "./layout";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="Landscape" component={Demo} durationInFrames={f(DURATION)} fps={FPS} width={LANDSCAPE.width} height={LANDSCAPE.height} defaultProps={{ layout: LANDSCAPE }} />
    <Composition id="Vertical" component={Demo} durationInFrames={f(DURATION)} fps={FPS} width={VERTICAL.width} height={VERTICAL.height} defaultProps={{ layout: VERTICAL }} />
  </>
);
