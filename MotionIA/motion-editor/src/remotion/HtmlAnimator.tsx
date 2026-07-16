'use client';

import {
  AbsoluteFill,
  Video,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { useMemo } from 'react';
import type { ElementClip } from '@/lib/animation';

export interface AnimDef {
  property: string;
  from: number;
  to: number;
  unit: string;
  startFrame: number;
  endFrame: number;
  type: 'spring' | 'ease';
}

export interface AnimationConfig {
  elementId: string;
  animations: AnimDef[];
  durationFrames?: number;
}

interface Props {
  html: string;
  animationConfigs: AnimationConfig[];
  videoSrc?: string;
  elementClips?: ElementClip[];
}

const TRANSFORM_PROPS = new Set(['translateY', 'translateX', 'scale', 'scaleX', 'scaleY', 'rotate']);

export const HtmlAnimator = ({ html, animationConfigs, videoSrc, elementClips = [] }: Props) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Parse each element's base transform from HTML so we can compose animation on top
  const baseTransforms = useMemo(() => {
    const map = new Map<string, string>();
    if (typeof window === 'undefined') return map;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('[data-element-id]').forEach(el => {
      const id = el.getAttribute('data-element-id') ?? '';
      const t = (el as HTMLElement).style.transform;
      if (id && t) map.set(id, t);
    });
    return map;
  }, [html]);

  const clipMap = useMemo(() => new Map(elementClips.map(c => [c.elementId, c])), [elementClips]);

  const animCss = animationConfigs.map(({ elementId, animations }) => {
    const clip = clipMap.get(elementId);
    const clipIn = clip?.inFrame ?? 0;
    const clipOut = clip?.outFrame ?? durationInFrames;

    // Element is outside its clip range — hide it
    if (frame < clipIn || frame >= clipOut) {
      return `[data-element-id="${elementId}"] { display: none !important }`;
    }

    const localFrame = Math.max(0, frame - clipIn);
    const transforms: string[] = [];
    const others: string[] = [];

    for (const anim of animations) {
      const tau = Math.max(0, localFrame - anim.startFrame);
      let value: number;

      if (anim.type === 'spring') {
        value = spring({
          frame: tau,
          fps,
          from: anim.from,
          to: anim.to,
          config: { damping: 12, stiffness: 180, mass: 0.4 },
        });
      } else {
        value = interpolate(
          localFrame,
          [anim.startFrame, anim.endFrame],
          [anim.from, anim.to],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
        );
      }

      const valStr = `${value}${anim.unit}`;
      if (TRANSFORM_PROPS.has(anim.property)) {
        transforms.push(`${anim.property}(${valStr})`);
      } else {
        others.push(`${anim.property}: ${valStr} !important`);
      }
    }

    const parts = [...others];
    if (transforms.length) {
      // Compose animation transforms with the element's base transform (e.g. translate from move tool)
      const baseT = baseTransforms.get(elementId) ?? '';
      const composed = baseT ? `${baseT} ${transforms.join(' ')}` : transforms.join(' ');
      parts.push(`transform: ${composed} !important`);
    }

    return `[data-element-id="${elementId}"] { ${parts.join('; ')} }`;
  }).join('\n');

  const bgOverride = videoSrc
    ? `<style>html,body{background:transparent!important}#root{background:transparent!important}</style>`
    : '';

  const fullHtml = `${html}${bgOverride}${animCss ? `<style>${animCss}</style>` : ''}`;

  return (
    <AbsoluteFill style={{ background: videoSrc ? 'transparent' : 'white', overflow: 'hidden' }}>
      {videoSrc && (
        <AbsoluteFill>
          <Video
            src={videoSrc}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
      )}

      <AbsoluteFill>
        <div
          style={{ width: '100%', height: '100%' }}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: fullHtml }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
