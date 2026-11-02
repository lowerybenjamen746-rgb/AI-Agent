export type Aspect = "9:16" | "1:1" | "4:5" | "16:9";

export const ASPECT_SIZES: Record<Aspect, [number, number]> = {
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
  "16:9": [1920, 1080],
};

export function buildAspectCropFilter(aspect: Aspect): string {
  const [w, h] = ASPECT_SIZES[aspect];
  const r = (w / h).toFixed(4);
  const cw = `min(iw\\,ih*${r})`;
  const ch = `min(ih\\,iw/${r})`;
  return `crop=${cw}:${ch}:(iw-${cw})/2:(ih-${ch})/2,scale=${w}:${h},setsar=1`;
}
