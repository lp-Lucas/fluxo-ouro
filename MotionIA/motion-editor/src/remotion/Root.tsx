import { Composition } from 'remotion';
import { HtmlAnimator } from './HtmlAnimator';

export const RemotionRoot = () => (
  <Composition
    id="HtmlAnimator"
    component={HtmlAnimator}
    durationInFrames={90}
    fps={30}
    width={800}
    height={600}
    defaultProps={{
      html: '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-family:sans-serif;color:#888">Preview aparece aqui</div>',
      animationConfigs: [],
    }}
  />
);
