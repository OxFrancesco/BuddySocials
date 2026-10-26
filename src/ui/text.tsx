import { Text, type TextProps, type TextStyle } from "react-native";
import { color, font } from "@/theme";

type Props = TextProps & { tone?: "fg" | "dim" | "faint" | "coral" | "bg" };

const tones = { fg: color.fg, dim: color.dim, faint: color.faint, coral: color.coral, bg: color.bg };

/** Uppercase Chakra Petch heading. */
export function Display({ size = 28, tone = "fg", style, ...props }: Props & { size?: number }) {
  return (
    <Text
      {...props}
      style={[
        {
          fontFamily: font.display,
          fontSize: size,
          lineHeight: Math.round(size * 1.05),
          letterSpacing: -0.025 * size,
          textTransform: "uppercase",
          color: tones[tone],
        },
        style,
      ]}
    />
  );
}

/** The reading voice: mono 14 with relaxed leading. */
export function Body({ tone = "fg", style, ...props }: Props) {
  return <Text {...props} style={[{ fontFamily: font.mono, fontSize: 14, lineHeight: 22, color: tones[tone] }, style]} />;
}

/** Mono micro label, 10px uppercase, wide tracking. The smaller the type, the wider the tracking. */
export function Label({ tone = "dim", style, size = 10, ...props }: Props & { size?: number }) {
  const tracking: TextStyle["letterSpacing"] = size <= 10 ? 1.4 : size <= 12 ? 0.6 : 0.4;
  return (
    <Text
      {...props}
      style={[
        {
          fontFamily: font.monoBold,
          fontSize: size,
          lineHeight: Math.round(size * 1.4),
          letterSpacing: tracking,
          textTransform: "uppercase",
          color: tones[tone],
        },
        style,
      ]}
    />
  );
}

/** Numbers are mono too. */
export function Figure({ size = 40, tone = "fg", style, ...props }: Props & { size?: number }) {
  return (
    <Text
      {...props}
      style={[
        { fontFamily: font.mono, fontSize: size, lineHeight: Math.round(size * 1.05), letterSpacing: -0.02 * size, color: tones[tone] },
        style,
      ]}
    />
  );
}
