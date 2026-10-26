import { Image, View } from "react-native";
import { DitherAvatar } from "react-native-dither-kit";
import { color } from "@/theme";

/** The platform's thumbnail, or a dither pattern seeded by the post when there is none. */
export function Thumb({ seed, url, size }: { seed: string; url: string | null; size: number }) {
  return (
    <View style={{ width: size, height: size, borderWidth: 2, borderColor: color.line, overflow: "hidden" }}>
      {url ? (
        <Image source={{ uri: url }} style={{ width: size - 4, height: size - 4 }} resizeMode="cover" />
      ) : (
        <DitherAvatar name={seed} hue={color.coral} size={size - 4} animate={false} />
      )}
    </View>
  );
}
