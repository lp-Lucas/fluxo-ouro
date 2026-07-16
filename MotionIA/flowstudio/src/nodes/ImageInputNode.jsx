import { Handle, Position, useReactFlow } from '@xyflow/react'
import { useRef, useCallback } from 'react'

export default function ImageInputNode({ id, data }) {
  const { updateNodeData } = useReactFlow()
  const fileRef = useRef()

  const handleFile = useCallback(async e => {
    const file = e.target.files[0]
    if (!file) return

    const previewUrl = URL.createObjectURL(file)
    updateNodeData(id, { previewUrl, filename: file.name, status: 'uploading', uploadId: '' })

    const form = new FormData()
    form.append('file', file)

    try {
      const res  = await fetch('/api/upload', { method: 'POST', body: form })
      const json = await res.json()
      updateNodeData(id, {
        previewUrl,
        filename:  file.name,
        uploadId:  json.upload_id  || '',
        localPath: json.local_path || '',
        status:    json.upload_id ? 'ready' : 'local',
        warn:      json.warn || '',
      })
    } catch (err) {
      updateNodeData(id, { previewUrl, filename: file.name, status: 'error', warn: err.message })
    }
  }, [id, updateNodeData])

  const statusCls   = { ready: 'done', uploading: 'running', local: 'running', error: 'error' }
  const statusLabel = { ready: '✓ enviado', uploading: 'enviando…', local: '⚠ sem ID', error: '✗ erro' }

  return (
    <div className="rf-node">
      <div className="rf-node-header" style={{ background: '#1a5c34' }}>
        📁 Imagem Input
      </div>

      <div className="rf-node-body nodrag">
        {data.previewUrl ? (
          <>
            <img
              src={data.previewUrl}
              className="rf-img-preview"
              onClick={() => fileRef.current.click()}
              title="Clique para trocar"
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: '#2a2a2a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {data.filename}
              </span>
              {data.status && (
                <span className={`rf-status ${statusCls[data.status] || 'idle'}`}>
                  {statusLabel[data.status] || data.status}
                </span>
              )}
            </div>
            {data.warn && (
              <div style={{ fontSize: 10, color: '#886600' }}>{data.warn}</div>
            )}
          </>
        ) : (
          <div className="rf-upload-zone" onClick={() => fileRef.current.click()}>
            <span className="icon">🖼</span>
            Clique para selecionar<br />
            <span style={{ color: '#1e1e1e' }}>PNG · JPG · WEBP</span>
          </div>
        )}

        <input
          type="file"
          ref={fileRef}
          style={{ display: 'none' }}
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={handleFile}
        />
      </div>

      <Handle
        type="source"
        position={Position.Right}
        id="image"
        className="handle-image"
        title="imagem"
      />
    </div>
  )
}
