'use client';

import { Player } from '@remotion/player';
import { useMemo } from 'react';
import { HtmlAnimator } from '@/remotion/HtmlAnimator';
import type { AnimationConfig } from '@/remotion/HtmlAnimator';
import type { ElementClip } from '@/lib/animation';

export type { AnimationConfig };

interface Props {
  html: string;
  animationConfigs: AnimationConfig[];
  videoSrc?: string | null;
  compositionWidth?: number;
  compositionHeight?: number;
  videoDurationFrames?: number;
  elementClips?: ElementClip[];
}

export default function RemotionPreview({
  html,
  animationConfigs,
  videoSrc,
  compositionWidth = 800,
  compositionHeight = 550,
  videoDurationFrames,
  elementClips = [],
}: Props) {
  const durationInFrames = useMemo(() => {
    // If a video is loaded, match its duration
    if (videoDurationFrames && videoDurationFrames > 0) return videoDurationFrames;
    // Otherwise derive from animation configs
    const max = animationConfigs.reduce((acc, c) => Math.max(acc, c.durationFrames ?? 60), 60);
    return max + 15;
  }, [animationConfigs, videoDurationFrames]);

  if (!html && !videoSrc) return null;

  // Scale preview to fit the 288px panel width
  const panelW = 288;
  const scale = panelW / compositionWidth;
  const previewH = Math.round(compositionHeight * scale);

  return (
    <div className="border-t border-gray-800 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Preview Remotion
        </span>
        <span className="text-[10px] text-gray-600">
          {compositionWidth}×{compositionHeight}
        </span>
      </div>

      <div className="rounded-lg overflow-hidden bg-black" style={{ height: previewH }}>
        <Player
          component={HtmlAnimator}
          inputProps={{ html: html || '', animationConfigs, videoSrc: videoSrc ?? undefined, elementClips }}
          durationInFrames={Math.max(1, durationInFrames)}
          fps={30}
          compositionWidth={compositionWidth}
          compositionHeight={compositionHeight}
          style={{ width: '100%', height: '100%' }}
          controls
          loop
        />
      </div>

      {animationConfigs.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {animationConfigs.map((c) => (
            <span
              key={c.elementId}
              className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-400 font-mono"
            >
              {c.elementId}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
