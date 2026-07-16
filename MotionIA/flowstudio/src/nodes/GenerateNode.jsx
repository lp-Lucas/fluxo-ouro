import { Handle, Position, useReactFlow } from '@xyflow/react'
import { useCallback, useEffect, useRef } from 'react'

export default function GenerateNode({ id, data }) {
  const { updateNodeData, getNodes, getEdges } = useReactFlow()
  const pollRef = useRef(null)

  const getInput = useCallback(handleId => {
    const edge = getEdges().find(e => e.target === id && e.targetHandle === handleId)
    if (!edge) return null
    return getNodes().find(n => n.id === edge.source)?.data ?? null
  }, [id, getNodes, getEdges])

  const propagateVideo = useCallback(url => {
    getEdges()
      .filter(e => e.source === id && e.sourceHandle === 'video')
      .forEach(e => updateNodeData(e.target, { videoUrl: url }))
  }, [id, getEdges, updateNodeData])

  const startPolling = useCallback(jobId => {
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/job/${jobId}`)
        const job = await res.json()

        if (job.status === 'done') {
          clearInterval(pollRef.current)
          const url = job.local_url || job.url
          updateNodeData(id, {
            status: 'done', videoUrl: url, jobId, error: null,
            credits: job.credits || null,
          })
          propagateVideo(url)
        } else if (job.status === 'error') {
          clearInterval(pollRef.current)
          updateNodeData(id, { status: 'error', error: job.error, jobId })
        }
      } catch (err) {
        clearInterval(pollRef.current)
        updateNodeData(id, { status: 'error', error: err.message })
      }
    }, 6000)
  }, [id, updateNodeData, propagateVideo])

  useEffect(() => () => clearInterval(pollRef.current), [])

  const handleGenerate = useCallback(async () => {
    const promptData = getInput('prompt')
    const imageData  = getInput('image')
    const modelData  = getInput('config')

    const prompt = (promptData?.text || '').trim()
    if (!prompt) {
      alert('Conecte e preencha um nó de Prompt!')
      return
    }

    clearInterval(pollRef.current)
    updateNodeData(id, { status: 'running', error: null, videoUrl: null, jobId: null })

    const body = {
      prompt,
      upload_id: imageData?.uploadId || '',
      model:     modelData?.model        || 'seedance_2_0',
      params: {
        aspect_ratio:    modelData?.aspect_ratio    || '9:16',
        duration:        modelData?.duration        || 5,
        resolution:      modelData?.resolution      || '720p',
        mode:            modelData?.mode            || 'std',
        generate_audio:  modelData?.generate_audio  ?? false,
      },
    }

    try {
      const res  = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (json.error) {
        updateNodeData(id, { status: 'error', error: json.error })
        return
      }
      updateNodeData(id, { jobId: json.job_id, estimatedCost: json.estimated_cost || null })
      startPolling(json.job_id)
    } catch (err) {
      updateNodeData(id, { status: 'error', error: err.message })
    }
  }, [id, getInput, updateNodeData, startPolling])

  const s = data.status || 'idle'

  const INPUTS = [
    { handle: 'prompt', label: 'Prompt',  dotColor: '#0033ff' },
    { handle: 'image',  label: 'Imagem',  dotColor: '#22cc66' },
    { handle: 'config', label: 'Modelo',  dotColor: '#9933ff' },
  ]

  return (
    <div className="rf-node" style={{ minWidth: 280 }}>
      <div className="rf-node-header" style={{ background: '#b84a00' }}>
        ⚡ Gerar Vídeo
      </div>

      <div className="rf-node-body nodrag">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {INPUTS.map(inp => (
            <div key={inp.handle} className="handle-row">
              <div className="handle-dot" style={{ background: inp.dotColor }} />
              <span>{inp.label}</span>
            </div>
          ))}
        </div>

        <div style={{ height: 1, background: '#1a1a1a' }} />

        <button
          className="rf-gen-btn"
          onClick={handleGenerate}
          disabled={s === 'running'}
        >
          {s === 'running'
            ? <><span className="rf-spinner" />Gerando…</>
            : '⚡ Gerar vídeo'
          }
        </button>

        {s !== 'idle' && (
          <div className={`rf-status ${s}`}>
            {s === 'running' ? 'Processando no Higgsfield…'
             : s === 'done'  ? '✓ Vídeo gerado!'
             : '✗ Erro na geração'}
          </div>
        )}

        {data.error && (
          <div className="rf-error-log">{data.error}</div>
        )}

        {data.estimatedCost != null && s === 'running' && (
          <div style={{ fontSize: 10, color: '#2a5c2a', background: '#0a140a', border: '1px solid #1a3a1a', borderRadius: 5, padding: '3px 8px' }}>
            estimado: {data.estimatedCost} créditos
          </div>
        )}

        {data.credits && s === 'done' && (
          <div style={{ background: '#0a0a14', border: '1px solid #1a1a3a', borderRadius: 6, padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ fontSize: 10, color: '#4466ff', fontWeight: 700, letterSpacing: '0.08em' }}>CRÉDITOS</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: '#555' }}>gastos</span>
              <span style={{ color: '#ff6644' }}>−{data.credits.spent}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: '#555' }}>saldo</span>
              <span style={{ color: '#44cc66' }}>{data.credits.remaining.toLocaleString('pt-BR')}</span>
            </div>
          </div>
        )}

        {data.jobId && (
          <div style={{ fontSize: 10, color: '#242424', fontFamily: 'monospace' }}>
            job: {data.jobId}
          </div>
        )}

        {data.videoUrl && (
          <div className="rf-node-footer">
            <a href={data.videoUrl} target="_blank" rel="noreferrer" className="rf-small-btn">
              ↗ Abrir
            </a>
            <a href={data.videoUrl} download className="rf-small-btn">
              ⬇ Baixar
            </a>
          </div>
        )}
      </div>

      <Handle type="target" position={Position.Left}  id="prompt" className="handle-prompt" style={{ top: '28%' }} />
      <Handle type="target" position={Position.Left}  id="image"  className="handle-image"  style={{ top: '44%' }} />
      <Handle type="target" position={Position.Left}  id="config" className="handle-config" style={{ top: '60%' }} />
      <Handle type="source" position={Position.Right} id="video"  className="handle-video"  />
    </div>
  )
}
