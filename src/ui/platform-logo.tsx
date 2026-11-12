import Svg, { Path } from "react-native-svg";
import { PLATFORM_LABEL, PLATFORM_LOGO, type Platform } from "@shared/platforms";
import { color } from "@/theme";

/** The platform's mark in place of its name. White by default; pass the platform colour where it doubles as a legend swatch. */
export function PlatformLogo({ platform, size = 12, tint = color.fg, opacity = 1 }: { platform: Platform; size?: number; tint?: string; opacity?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityLabel={PLATFORM_LABEL[platform]} style={{ opacity }}>
      <Path d={PLATFORM_LOGO[platform]} fill={tint} />
    </Svg>
  );
}
