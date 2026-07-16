import { Handle, Position, useReactFlow } from '@xyflow/react'

export default function PromptNode({ id, data }) {
  const { updateNodeData } = useReactFlow()
  const len = (data.text || '').length

  return (
    <div className="rf-node" style={{ minWidth: 320 }}>
      <div className="rf-node-header" style={{ background: '#0033cc' }}>
        ✏️ Prompt
      </div>

      <div className="rf-node-body nodrag">
        <textarea
          className="rf-textarea mono"
          rows={9}
          value={data.text || ''}
          onChange={e => updateNodeData(id, { text: e.target.value })}
          placeholder={
            'Descreva o vídeo em detalhes:\n\n' +
            '• movimento de câmera\n' +
            '• animações de elementos\n' +
            '• transições e timing\n' +
            '• estilo e atmosfera'
          }
        />
        <div className={`rf-char-count ${len > 2000 ? 'warn' : ''}`}>
          {len} / 2500 chars
          {len > 2000 ? ' ⚠ próximo do limite' : ''}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        id="prompt"
        className="handle-prompt"
        title="prompt"
      />
    </div>
  )
}
