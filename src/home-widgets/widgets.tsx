import { FlexWidget, SvgWidget, TextWidget } from "react-native-android-widget";
import { compact, percentChange, relativeTime, signedPercent } from "@shared/format";
import { PLATFORM_TAG } from "@shared/platforms";
import { ditherAreaSvg } from "./dither-svg";
import type { HomeSnapshot } from "./snapshot";

/** Same tokens as the app. Widget primitives need literal colours. */
const BG = "#000000";
const FG = "#FFFFFF";
const CORAL = "#D6544B";
const LINE = "#292929";
const DIM = "rgba(255, 255, 255, 0.7)";
const PAD = 14;

type Size = { width: number; height: number };

function Shell({ children, uri, chart, ...size }: Size & { children: React.ReactNode; uri: string; chart?: React.ReactNode }) {
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri }}
      style={{
        width: size.width,
        height: size.height,
        backgroundColor: BG,
        borderWidth: 2,
        borderColor: LINE,
        flexDirection: "column",
      }}
    >
      <FlexWidget
        style={{
          flex: 1,
          width: "match_parent",
          padding: PAD,
          paddingBottom: chart ? 8 : PAD,
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        {children}
      </FlexWidget>
      {/* Charts run edge to edge along the bottom, like the in-app widgets. */}
      {chart ?? null}
    </FlexWidget>
  );
}

function Micro({ text, color = DIM }: { text: string; color?: `#${string}` | `rgba(${number}, ${number}, ${number}, ${number})` }) {
  return (
    <TextWidget
      text={text.toUpperCase()}
      maxLines={1}
      truncate="END"
      style={{ fontFamily: "IBMPlexMono-Bold", fontSize: 10, letterSpacing: 0.14, color }}
    />
  );
}

function Big({ text, size }: { text: string; size: number }) {
  return <TextWidget text={text} maxLines={1} style={{ fontFamily: "IBMPlexMono-Regular", fontSize: size, color: FG }} />;
}

/** Shown before the app has issued a widget token, or when it was revoked. */
export function SetupWidget(size: Size) {
  return (
    <Shell {...size} uri="buddysocials://">
      <TextWidget text="BUDDYSOCIALS" style={{ fontFamily: "ChakraPetch-Bold", fontSize: 18, color: FG }} />
      <Micro text="Open the app to load your stats" />
    </Shell>
  );
}

export function ViewsWidget({ snapshot, ...size }: Size & { snapshot: HomeSnapshot }) {
  const change = percentChange(snapshot.week, snapshot.previousWeek);
  const tall = size.height > 150;
  const chartWidth = size.width - 4;
  const chartHeight = Math.max(28, Math.round(size.height * (tall ? 0.42 : 0.36)));
  const platforms = snapshot.perPlatform.filter((entry) => entry.views > 0).sort((a, b) => b.views - a.views);
  return (
    <Shell
      {...size}
      uri="buddysocials://"
      chart={
        <SvgWidget
          svg={ditherAreaSvg(snapshot.daily, { width: chartWidth, height: chartHeight, color: CORAL, splitAt: 7 })}
          style={{ width: chartWidth, height: chartHeight }}
        />
      }
    >
      <FlexWidget style={{ flexDirection: "row", justifyContent: "space-between", width: "match_parent" }}>
        <Micro text="Views · 7d" />
        {change !== undefined ? <Micro text={signedPercent(change)} color={change < 0 ? CORAL : FG} /> : <Micro text="" />}
      </FlexWidget>
      <Big text={compact(snapshot.week)} size={tall ? 40 : 30} />
      {tall && platforms.length > 0 ? (
        <FlexWidget style={{ flexDirection: "row", flexGap: 12 }}>
          {platforms.slice(0, size.width > 300 ? 5 : 3).map((entry) => (
            <Micro key={entry.platform} text={`${PLATFORM_TAG[entry.platform]} ${compact(entry.views)}`} color={FG} />
          ))}
        </FlexWidget>
      ) : null}
    </Shell>
  );
}

export function InboxWidget({ snapshot, ...size }: Size & { snapshot: HomeSnapshot }) {
  const now = Date.now();
  const show = size.height > 150 ? 2 : 1;
  return (
    <Shell {...size} uri="buddysocials://inbox">
      <Micro text="Inbox" />
      <Big text={snapshot.openCount >= 100 ? "99+" : String(snapshot.openCount)} size={size.height > 150 ? 40 : 30} />
      <FlexWidget style={{ flexDirection: "column", flexGap: 6, width: "match_parent" }}>
        {snapshot.latest.slice(0, show).map((comment) => (
          <FlexWidget key={comment.id} style={{ flexDirection: "column", width: "match_parent" }}>
            <Micro text={`${PLATFORM_TAG[comment.platform]} · ${comment.author} · ${relativeTime(comment.publishedAt, now)}`} />
            <TextWidget
              text={comment.text}
              maxLines={1}
              truncate="END"
              style={{ fontFamily: "IBMPlexMono-Regular", fontSize: 13, color: FG }}
            />
          </FlexWidget>
        ))}
      </FlexWidget>
    </Shell>
  );
}

export function PulseWidget({ snapshot, ...size }: Size & { snapshot: HomeSnapshot }) {
  const chartWidth = size.width - 4;
  const chartHeight = Math.max(24, Math.round(size.height * 0.34));
  return (
    <Shell
      {...size}
      uri="buddysocials://"
      chart={
        <SvgWidget
          svg={ditherAreaSvg(snapshot.daily.slice(7), { width: chartWidth, height: chartHeight, color: CORAL })}
          style={{ width: chartWidth, height: chartHeight }}
        />
      }
    >
      <Micro text="Views · 7d" />
      <Big text={compact(snapshot.week)} size={28} />
      {snapshot.newFollowers > 0 ? <Micro text={`+${compact(snapshot.newFollowers)} followers`} color={FG} /> : <Micro text="" />}
    </Shell>
  );
}
