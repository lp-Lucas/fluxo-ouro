import { spring, interpolate } from 'remotion';
import type { AnimDef, AnimationConfig } from '@/remotion/HtmlAnimator';

export interface ElementClip {
  elementId: string;
  inFrame: number;
  outFrame: number | null; // null = end of timeline
}

export const TRANSFORM_PROPS = new Set([
  'translateY', 'translateX', 'scale', 'scaleX', 'scaleY', 'rotate',
]);

export const FPS = 30;

function computeSingleAnim(anim: AnimDef, localFrame: number): number {
  const tau = Math.max(0, localFrame - anim.startFrame);
  if (anim.type === 'spring') {
    return spring({
      frame: tau,
      fps: FPS,
      from: anim.from,
      to: anim.to,
      config: { damping: 12, stiffness: 180, mass: 0.4 },
    });
  }
  return interpolate(
    localFrame,
    [anim.startFrame, anim.endFrame],
    [anim.from, anim.to],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
}

export interface FrameState {
  visibility: { id: string; visible: boolean }[];
  styles: { id: string; props: Record<string, string> }[];
}

export function computeFrameState(
  animationConfigs: AnimationConfig[],
  elementClips: ElementClip[],
  globalFrame: number,
  totalFrames: number,
): FrameState {
  const clipMap = new Map(elementClips.map(c => [c.elementId, c]));

  const visibility = elementClips.map(clip => {
    const out = clip.outFrame ?? totalFrames;
    return { id: clip.elementId, visible: globalFrame >= clip.inFrame && globalFrame < out };
  });

  const styles: FrameState['styles'] = [];

  for (const config of animationConfigs) {
    const clip = clipMap.get(config.elementId);
    const clipIn = clip?.inFrame ?? 0;
    const clipOut = clip?.outFrame ?? totalFrames;
    if (clip && (globalFrame < clip.inFrame || globalFrame >= clipOut)) continue;

    const localFrame = Math.max(0, globalFrame - clipIn);
    const transforms: string[] = [];
    const props: Record<string, string> = {};

    for (const anim of config.animations) {
      const val = computeSingleAnim(anim, localFrame);
      const str = `${val}${anim.unit}`;
      if (TRANSFORM_PROPS.has(anim.property)) transforms.push(`${anim.property}(${str})`);
      else props[anim.property] = str;
    }
    if (transforms.length) props.transform = transforms.join(' ');
    if (Object.keys(props).length) styles.push({ id: config.elementId, props });
  }

  return { visibility, styles };
}
