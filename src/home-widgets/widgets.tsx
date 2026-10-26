import { FlexWidget, SvgWidget, TextWidget } from "react-native-android-widget";
import { compact, percentChange, relativeTime, signedPercent } from "@shared/format";
import { PLATFORM_COLOR, PLATFORM_LABEL, PLATFORM_TAG } from "@shared/platforms";
import { ditherAreaSvg, ditherBarSvg, ditherLinesSvg, goalBarSvg } from "./dither-svg";
import type { HomeSnapshot } from "./snapshot";

/** Same tokens as the app. Widget primitives need literal colours. */
const BG = "#000000";
const FG = "#FFFFFF";
const CORAL = "#D6544B";
const LINE = "#292929";
const DIM = "rgba(255, 255, 255, 0.7)";
const FAINT = "rgba(255, 255, 255, 0.6)";
const PAD = 16;
const BORDER = 2;

type Color = `#${string}` | `rgba(${number}, ${number}, ${number}, ${number})`;
type Size = { width: number; height: number };

/**
 * Widgets lay themselves out from their live size, so expanding one on the
 * home screen reveals more instead of stretching the same content.
 */
function layout({ width, height }: Size) {
  const narrow = width < 220;
  const short = height < 150;
  const tall = height >= 260;
  return { narrow, short, tall, inner: width - BORDER * 2 };
}

function Shell({
  children,
  uri,
  chart,
  stack = false,
  ...size
}: Size & { children: React.ReactNode; uri: string; chart?: React.ReactNode; stack?: boolean }) {
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri }}
      style={{ width: size.width, height: size.height, backgroundColor: BG, borderWidth: BORDER, borderColor: LINE, flexDirection: "column" }}
    >
      <FlexWidget
        style={{
          flex: 1,
          width: "match_parent",
          padding: PAD,
          paddingBottom: chart ? 10 : PAD,
          flexDirection: "column",
          justifyContent: stack ? "flex-start" : "space-between",
          flexGap: stack ? 14 : 0,
        }}
      >
        {children}
      </FlexWidget>
      {/* Charts run edge to edge along the bottom, like the in-app widgets. */}
      {chart ?? null}
    </FlexWidget>
  );
}

function Micro({ text, color = DIM, size = 10 }: { text: string; color?: Color; size?: number }) {
  return (
    <TextWidget
      text={text.toUpperCase()}
      maxLines={1}
      truncate="END"
      style={{ fontFamily: "IBMPlexMono-Bold", fontSize: size, letterSpacing: 0.12, color }}
    />
  );
}

function Big({ text, size, color = FG }: { text: string; size: number; color?: Color }) {
  return <TextWidget text={text} maxLines={1} style={{ fontFamily: "IBMPlexMono-Regular", fontSize: size, color }} />;
}

function Line({ text, size = 13, lines = 1, color = FG }: { text: string; size?: number; lines?: number; color?: Color }) {
  return (
    <TextWidget
      text={text}
      maxLines={lines}
      truncate="END"
      style={{ fontFamily: "IBMPlexMono-Regular", fontSize: size, color, lineHeight: Math.round(size * 1.35) }}
    />
  );
}

function Row({ children, gap = 12, between = false, fill = true }: { children: React.ReactNode; gap?: number; between?: boolean; fill?: boolean }) {
  return (
    <FlexWidget
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexGap: gap,
        width: fill ? "match_parent" : "wrap_content",
        justifyContent: between ? "space-between" : "flex-start",
      }}
    >
      {children}
    </FlexWidget>
  );
}

function Stat({ value, label, size }: { value: string; label: string; size: number }) {
  return (
    <FlexWidget style={{ flexDirection: "column" }}>
      <Big text={value} size={size} />
      <Micro text={label} />
    </FlexWidget>
  );
}

function Change({ current, previous, size = 10 }: { current: number; previous: number; size?: number }) {
  const change = percentChange(current, previous);
  if (change === undefined || !Number.isFinite(change)) return <Micro text="" />;
  return <Micro text={signedPercent(change)} color={change < 0 ? CORAL : FG} size={size} />;
}

function Chart({ values, width, height, splitAt }: { values: number[]; width: number; height: number; splitAt?: number }) {
  return (
    <SvgWidget
      svg={ditherAreaSvg(values, { width, height, color: CORAL, ...(splitAt !== undefined ? { splitAt } : {}) })}
      style={{ width, height }}
    />
  );
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

/* ---------------------------------------------------------------- Views */

export function ViewsWidget({ snapshot, ...size }: Size & { snapshot: HomeSnapshot }) {
  const { narrow, short, tall, inner } = layout(size);
  const platforms = snapshot.perPlatform.filter((entry) => entry.views > 0).sort((a, b) => b.views - a.views);
  if (short) {
    // One row: the number on the left, the week's curve filling the right.
    const chartWidth = Math.round(inner * (narrow ? 0.45 : 0.55));
    return (
      <FlexWidget
        clickAction="OPEN_URI"
        clickActionData={{ uri: "buddysocials://" }}
        style={{ width: size.width, height: size.height, backgroundColor: BG, borderWidth: BORDER, borderColor: LINE, flexDirection: "row" }}
      >
        <FlexWidget style={{ flex: 1, height: "match_parent", padding: PAD, flexDirection: "column", justifyContent: "space-between" }}>
          <Micro text="Views · 7d" />
          <Big text={compact(snapshot.week)} size={narrow ? 26 : 30} />
        </FlexWidget>
        <FlexWidget style={{ height: "match_parent", flexDirection: "column", justifyContent: "flex-end" }}>
          <Chart values={snapshot.daily.slice(7)} width={chartWidth} height={Math.round((size.height - BORDER * 2) * 0.7)} />
        </FlexWidget>
      </FlexWidget>
    );
  }
  const chartHeight = Math.max(32, Math.round(size.height * (tall ? 0.34 : 0.4)));
  const rows = tall ? Math.max(0, Math.floor((size.height - chartHeight - 150) / 26)) : 0;
  return (
    <Shell {...size} uri="buddysocials://" chart={<Chart values={snapshot.daily} width={inner} height={chartHeight} splitAt={7} />}>
      <Row between>
        <Micro text="Views · 7d" />
        <Change current={snapshot.week} previous={snapshot.previousWeek} />
      </Row>
      <Big text={compact(snapshot.week)} size={narrow ? 32 : tall ? 48 : 40} />
      {rows > 0 ? (
        <FlexWidget style={{ flexDirection: "column", flexGap: 8, width: "match_parent" }}>
          {platforms.slice(0, rows).map((entry) => (
            <Row key={entry.platform} between>
              <Micro text={PLATFORM_LABEL[entry.platform]} color={FG} size={11} />
              <Row gap={10} fill={false}>
                <Micro text={compact(entry.views)} color={FG} size={11} />
                <Change current={entry.views} previous={entry.previousViews} />
              </Row>
            </Row>
          ))}
        </FlexWidget>
      ) : !narrow && platforms.length > 0 ? (
        <Row>
          {platforms.slice(0, size.width > 320 ? 5 : 3).map((entry) => (
            <Micro key={entry.platform} text={`${PLATFORM_TAG[entry.platform]} ${compact(entry.views)}`} color={FG} />
          ))}
        </Row>
      ) : (
        <Change current={snapshot.week} previous={snapshot.previousWeek} size={11} />
      )}
    </Shell>
  );
}

/* ---------------------------------------------------------------- Inbox */

export function InboxWidget({ snapshot, ...size }: Size & { snapshot: HomeSnapshot }) {
  const { narrow, short, tall } = layout(size);
  const now = Date.now();
  const count = snapshot.openCount >= 100 ? "99+" : String(snapshot.openCount);
  const show = narrow ? (short ? 0 : 1) : short ? 1 : tall ? Math.max(2, Math.floor((size.height - 110) / 52)) : 2;
  const comments = snapshot.latest.slice(0, show).map((comment) => (
    <FlexWidget key={comment.id} style={{ flexDirection: "column", width: "match_parent" }}>
      <Micro text={`${PLATFORM_TAG[comment.platform]} · ${comment.author} · ${relativeTime(comment.publishedAt, now)}`} />
      <Line text={comment.text} lines={narrow || tall ? 2 : 1} />
    </FlexWidget>
  ));
  if (short && !narrow) {
    return (
      <Shell {...size} uri="buddysocials://inbox">
        <Row gap={18}>
          <FlexWidget style={{ flexDirection: "column" }}>
            <Micro text="Inbox" />
            <Big text={count} size={30} />
          </FlexWidget>
          <FlexWidget style={{ flex: 1, flexDirection: "column" }}>{comments}</FlexWidget>
        </Row>
      </Shell>
    );
  }
  return (
    <Shell {...size} uri="buddysocials://inbox">
      <Micro text="Inbox" />
      <Big text={count} size={narrow ? 32 : 40} />
      {snapshot.openCount === 0 ? null : <FlexWidget style={{ flexDirection: "column", flexGap: 10, width: "match_parent" }}>{comments}</FlexWidget>}
    </Shell>
  );
}

/* ---------------------------------------------------------------- Pulse */

export function PulseWidget({ snapshot, ...size }: Size & { snapshot: HomeSnapshot }) {
  const { narrow, short, inner } = layout(size);
  const chartHeight = Math.max(24, Math.round(size.height * 0.34));
  const stats = [
    { value: compact(snapshot.week), label: "Views" },
    ...(snapshot.engagement > 0 ? [{ value: compact(snapshot.engagement), label: "Interactions" }] : []),
    ...(snapshot.newFollowers > 0 ? [{ value: `+${compact(snapshot.newFollowers)}`, label: "Followers" }] : []),
  ];
  if (short) {
    return (
      <Shell {...size} uri="buddysocials://">
        <Micro text="This week" />
        <Row gap={18}>
          {stats.slice(0, narrow ? 1 : size.width >= 300 ? 3 : 2).map((stat) => (
            <Stat key={stat.label} value={stat.value} label={stat.label} size={22} />
          ))}
        </Row>
      </Shell>
    );
  }
  return (
    <Shell {...size} uri="buddysocials://" chart={<Chart values={snapshot.daily.slice(7)} width={inner} height={chartHeight} />}>
      <Micro text="This week" />
      {narrow ? (
        <FlexWidget style={{ flexDirection: "column", flexGap: 6 }}>
          <Big text={stats[0]!.value} size={30} />
          {snapshot.newFollowers > 0 ? <Micro text={`+${compact(snapshot.newFollowers)} followers`} color={FG} /> : null}
        </FlexWidget>
      ) : (
        <Row gap={22}>
          {stats.slice(0, size.width >= 300 ? 3 : 2).map((stat) => (
            <Stat key={stat.label} value={stat.value} label={stat.label} size={26} />
          ))}
        </Row>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------ Platforms */

export function PlatformsWidget({ snapshot, ...size }: Size & { snapshot: HomeSnapshot }) {
  const { narrow, tall, inner } = layout(size);
  const entries = snapshot.perPlatform.filter((entry) => entry.views > 0).sort((a, b) => b.views - a.views);
  const max = Math.max(1, ...entries.map((entry) => entry.views));
  if (tall && !narrow) {
    // Expanded: each platform gets its own line, a full-width bar and its followers.
    const withFollowers = size.height >= 420;
    const fit = Math.max(1, Math.floor((size.height - 60) / (withFollowers ? 72 : 50)));
    const barWidth = inner - PAD * 2;
    return (
      <Shell {...size} uri="buddysocials://">
        <Micro text="Views by platform · 7d" />
        <FlexWidget style={{ flex: 1, flexDirection: "column", justifyContent: "space-around", width: "match_parent", paddingTop: 8 }}>
          {entries.slice(0, fit).map((entry) => (
            <FlexWidget key={entry.platform} style={{ flexDirection: "column", flexGap: 6, width: "match_parent" }}>
              <Row between>
                <Micro text={PLATFORM_LABEL[entry.platform]} color={FG} size={12} />
                <Row gap={10} fill={false}>
                  <Micro text={compact(entry.views)} color={FG} size={12} />
                  <Change current={entry.views} previous={entry.previousViews} size={11} />
                </Row>
              </Row>
              <SvgWidget
                svg={ditherBarSvg({ width: barWidth, height: 14, share: entry.views / max, color: PLATFORM_COLOR[entry.platform] })}
                style={{ width: barWidth, height: 14 }}
              />
              {withFollowers && entry.followers ? <Micro text={`${compact(entry.followers)} followers`} color={FAINT} /> : null}
            </FlexWidget>
          ))}
        </FlexWidget>
      </Shell>
    );
  }
  const rowHeight = narrow ? 34 : 28;
  const fit = Math.max(1, Math.floor((size.height - 64) / rowHeight));
  const tagWidth = 28;
  const valueWidth = narrow ? 0 : 92;
  const barWidth = Math.max(24, inner - PAD * 2 - tagWidth - valueWidth - 20);
  return (
    <Shell {...size} uri="buddysocials://" stack>
      <Micro text="Views by platform · 7d" />
      <FlexWidget style={{ flexDirection: "column", flexGap: narrow ? 6 : 8, width: "match_parent" }}>
        {entries.slice(0, fit).map((entry) => (
          <FlexWidget key={entry.platform} style={{ flexDirection: "row", alignItems: "center", flexGap: 10, width: "match_parent" }}>
            <FlexWidget style={{ width: tagWidth }}>
              <Micro text={PLATFORM_TAG[entry.platform]} color={FG} size={11} />
            </FlexWidget>
            <SvgWidget
              svg={ditherBarSvg({ width: barWidth, height: 12, share: entry.views / max, color: PLATFORM_COLOR[entry.platform] })}
              style={{ width: barWidth, height: 12 }}
            />
            {narrow ? null : (
              <FlexWidget style={{ width: valueWidth, flexDirection: "row", justifyContent: "flex-end", flexGap: 8 }}>
                <Micro text={compact(entry.views)} color={FG} size={11} />
                <Change current={entry.views} previous={entry.previousViews} />
              </FlexWidget>
            )}
          </FlexWidget>
        ))}
      </FlexWidget>
    </Shell>
  );
}

/* ---------------------------------------------------------------- Goals */

export function GoalsWidget({ snapshot, ...size }: Size & { snapshot: HomeSnapshot }) {
  const { narrow, inner } = layout(size);
  const goals = snapshot.goals ?? [];
  const { tall } = layout(size);
  const perGoal = narrow ? 50 : tall ? 58 : 46;
  const fit = Math.max(1, Math.floor((size.height - 56) / perGoal));
  const barWidth = inner - PAD * 2;
  return (
    <Shell {...size} uri="buddysocials://goals" stack>
      <Micro text="Goals" />
      {goals.length === 0 ? (
        <Line text="Set a goal in the app" color={FAINT} />
      ) : (
        <FlexWidget style={{ flexDirection: "column", flexGap: 12, width: "match_parent" }}>
          {goals.slice(0, fit).map((goal) => {
            const percent = `${Math.round(goal.progress * 100)}%`;
            const status = goal.state === "done" ? "Done" : goal.state === "behind" ? `${percent} · behind` : percent;
            return (
              <FlexWidget key={goal.id} style={{ flexDirection: "column", flexGap: 5, width: "match_parent" }}>
                <Row between>
                  <FlexWidget style={{ flex: 1 }}>
                    <Line text={goal.title} size={12} />
                  </FlexWidget>
                  {narrow ? null : <Micro text={status} color={goal.state === "behind" ? CORAL : FG} />}
                </Row>
                <SvgWidget
                  svg={goalBarSvg({ width: barWidth, height: tall ? 14 : 10, progress: goal.progress, pace: goal.pace, color: CORAL, line: LINE })}
                  style={{ width: barWidth, height: tall ? 14 : 10 }}
                />
                {tall ? (
                  <Micro
                    text={[`${compact(goal.value)} of ${compact(goal.target)}`, goal.daysLeft > 0 && goal.state !== "done" ? `${goal.daysLeft}d left` : null, goal.streak >= 2 ? `streak ${goal.streak}` : null].filter(Boolean).join(" · ")}
                    color={FAINT}
                  />
                ) : null}
              </FlexWidget>
            );
          })}
        </FlexWidget>
      )}
    </Shell>
  );
}

/* ---------------------------------------------------------- Latest post */

export function LatestPostWidget({ snapshot, ...size }: Size & { snapshot: HomeSnapshot }) {
  const { narrow, short, inner } = layout(size);
  const post = snapshot.latestPost;
  if (!post) {
    return (
      <Shell {...size} uri="buddysocials://posts">
        <Micro text="Latest post" />
        <Line text="No posts yet" color={FAINT} />
      </Shell>
    );
  }
  const stats = [
    ["Views", post.views],
    ["Likes", post.likes],
    ["Comments", post.comments],
  ].filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0);
  const showCurve = !short && post.curve.length > 2;
  const chartHeight = Math.max(24, Math.round(size.height * 0.28));
  return (
    <Shell
      {...size}
      uri={`buddysocials://post/${post.id}`}
      chart={showCurve ? <Chart values={post.curve} width={inner} height={chartHeight} /> : undefined}
    >
      <FlexWidget style={{ flexDirection: "column", flexGap: 8, width: "match_parent" }}>
        <Micro text={`${PLATFORM_LABEL[post.platform]} · ${relativeTime(post.publishedAt, Date.now())}`} />
        <TextWidget
          text={post.title.toUpperCase()}
          maxLines={short ? 1 : narrow ? 3 : 2}
          truncate="END"
          style={{ fontFamily: "ChakraPetch-Bold", fontSize: narrow ? 16 : short ? 16 : 20, color: FG, lineHeight: narrow ? 18 : 22 }}
        />
      </FlexWidget>
      <Row gap={18}>
        {stats.slice(0, narrow ? 1 : 3).map(([label, value]) => (
          <Stat key={label} value={compact(value)} label={label} size={short ? 20 : showCurve ? 24 : 30} />
        ))}
      </Row>
    </Shell>
  );
}

/* ------------------------------------------------------------------ Mix */

export function MixWidget({ snapshot, ...size }: Size & { snapshot: HomeSnapshot }) {
  const { narrow, short, tall, inner } = layout(size);
  const entries = snapshot.perPlatform.filter((entry) => entry.daily.some((value) => value > 0)).sort((a, b) => b.views - a.views);
  if (entries.length === 0) {
    return (
      <Shell {...size} uri="buddysocials://">
        <Micro text="Views by platform" />
        <Line text="No views yet" color={FAINT} />
      </Shell>
    );
  }
  // Last seven days, one overlapping line per platform; the biggest draws last so it sits on top.
  const week = entries.map((entry) => entry.daily.slice(-7));
  const days = Math.max(...week.map((values) => values.length));
  const chartHeight = Math.max(40, size.height - (short ? 62 : tall ? 120 : 92));
  const legend = entries.slice(0, narrow ? 3 : 5);
  return (
    <Shell
      {...size}
      uri="buddysocials://"
      stack
      chart={
        <SvgWidget
          svg={ditherLinesSvg([...week].reverse(), entries.map((entry) => PLATFORM_COLOR[entry.platform]).reverse(), { width: inner, height: chartHeight })}
          style={{ width: inner, height: chartHeight }}
        />
      }
    >
      <Micro text={`Views by platform · ${days}d`} />
      <FlexWidget style={{ flexDirection: tall && !narrow ? "column" : "row", flexGap: tall ? 6 : 12, width: "match_parent" }}>
        {legend.map((entry) => (
          <FlexWidget key={entry.platform} style={{ flexDirection: "row", alignItems: "center", flexGap: 6 }}>
            <FlexWidget style={{ width: 8, height: 8, backgroundColor: PLATFORM_COLOR[entry.platform] }} />
            <Micro text={tall && !narrow ? PLATFORM_LABEL[entry.platform] : PLATFORM_TAG[entry.platform]} color={FG} size={tall ? 11 : 10} />
            <Micro text={compact(entry.daily.slice(-7).reduce((a, b) => a + b, 0))} color={DIM} size={tall ? 11 : 10} />
          </FlexWidget>
        ))}
      </FlexWidget>
    </Shell>
  );
}
