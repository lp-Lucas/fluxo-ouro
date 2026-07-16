import { Handle, Position, useReactFlow } from '@xyflow/react'

const MODELS = [
  { id: 'seedance_2_0',               label: 'Seedance 2.0' },
  { id: 'seedance_2_0_mini',          label: 'Seedance 2.0 Mini' },
  { id: 'seedance1_5',                label: 'Seedance 1.5 Pro' },
  { id: 'kling3_0',                   label: 'Kling 3.0' },
  { id: 'kling3_0_turbo',             label: 'Kling 3.0 Turbo' },
  { id: 'kling2_6',                   label: 'Kling 2.6' },
  { id: 'cinematic_studio_video_3_5', label: 'Cinematic Studio 3.5' },
  { id: 'cinematic_studio_video_v2',  label: 'Cinematic Studio V2' },
  { id: 'veo3_1',                     label: 'Google Veo 3.1' },
  { id: 'veo3_1_lite',                label: 'Google Veo 3.1 Lite' },
  { id: 'veo3',                       label: 'Google Veo 3' },
  { id: 'grok_video_v15',             label: 'Grok Video 1.5' },
  { id: 'grok_video',                 label: 'Grok Video' },
  { id: 'minimax_hailuo',             label: 'Minimax Hailuo' },
  { id: 'wan2_7',                     label: 'Wan 2.7' },
  { id: 'wan2_6',                     label: 'Wan 2.6' },
]

const DEFAULTS = {
  model:           'seedance_2_0',
  aspect_ratio:    '9:16',
  duration:        5,
  resolution:      '720p',
  mode:            'std',
  generate_audio:  false,
}

export default function ModelNode({ id, data }) {
  const { updateNodeData } = useReactFlow()
  const d = { ...DEFAULTS, ...data }

  const set = key => e => updateNodeData(id, { [key]: e.target.value })

  return (
    <div className="rf-node">
      <div className="rf-node-header" style={{ background: '#5c1a8c' }}>
        🎬 Modelo
      </div>

      <div className="rf-node-body nodrag">

        <div>
          <div className="rf-label">Modelo de vídeo</div>
          <select className="rf-select" value={d.model} onChange={set('model')}>
            {MODELS.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>

        <div className="rf-row">
          <div>
            <div className="rf-label">Proporção</div>
            <select className="rf-select" value={d.aspect_ratio} onChange={set('aspect_ratio')}>
              <option value="9:16">9:16 — Reels</option>
              <option value="16:9">16:9 — Wide</option>
              <option value="1:1">1:1 — Square</option>
              <option value="4:3">4:3</option>
              <option value="3:4">3:4</option>
              <option value="21:9">21:9 — Cine</option>
              <option value="auto">Auto</option>
            </select>
          </div>
          <div>
            <div className="rf-label">Resolução</div>
            <select className="rf-select" value={d.resolution} onChange={set('resolution')}>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="4k">4K</option>
              <option value="480p">480p</option>
            </select>
          </div>
        </div>

        <div className="rf-row">
          <div>
            <div className="rf-label">Duração (s)</div>
            <input
              type="number"
              className="rf-input"
              value={d.duration}
              min={3} max={60} step={1}
              onChange={set('duration')}
            />
          </div>
          <div>
            <div className="rf-label">Modo</div>
            <select className="rf-select" value={d.mode} onChange={set('mode')}>
              <option value="std">Standard</option>
              <option value="fast">Fast</option>
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            id={`audio-${id}`}
            checked={!!d.generate_audio}
            onChange={e => updateNodeData(id, { generate_audio: e.target.checked })}
            style={{ accentColor: '#4466ff', cursor: 'pointer' }}
          />
          <label htmlFor={`audio-${id}`} style={{ fontSize: 10, color: '#888', cursor: 'pointer', userSelect: 'none' }}>
            Gerar áudio (Higgsfield AI)
          </label>
        </div>

        <div style={{ fontSize: 10, color: '#1e1e1e', lineHeight: 1.6 }}>
          modelo: <span style={{ color: '#2e2e2e' }}>{d.model}</span>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        id="config"
        className="handle-config"
        title="config"
      />
    </div>
  )
}
