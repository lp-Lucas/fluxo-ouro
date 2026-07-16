import { Handle, Position } from '@xyflow/react'
import { useRef, useEffect } from 'react'

export default function VideoPreviewNode({ data }) {
  const videoRef = useRef()

  useEffect(() => {
    if (!videoRef.current) return
    if (data.videoUrl) {
      videoRef.current.src = data.videoUrl
      videoRef.current.play().catch(() => {})
    }
  }, [data.videoUrl])

  return (
    <div className="rf-node" style={{ minWidth: 230 }}>
      <div className="rf-node-header" style={{ background: '#111', border: 'none' }}>
        ▶ Preview
      </div>

      <div className="rf-node-body nodrag">
        <div className="rf-video-shell">
          {data.videoUrl ? (
            <video ref={videoRef} loop playsInline muted autoPlay />
          ) : (
            <div className="rf-video-placeholder">▶</div>
          )}
        </div>

        {data.videoUrl && (
          <>
            <div className="rf-node-footer">
              <button
                className="rf-small-btn"
                onClick={() => {
                  if (!videoRef.current) return
                  videoRef.current.paused
                    ? videoRef.current.play()
                    : videoRef.current.pause()
                }}
              >
                ▶ / ⏸
              </button>
              <button
                className="rf-small-btn"
                onClick={() => {
                  if (!videoRef.current) return
                  videoRef.current.muted = !videoRef.current.muted
                }}
              >
                🔊 / 🔇
              </button>
            </div>
            <a
              href={data.videoUrl}
              download
              className="rf-small-btn"
              style={{ textAlign: 'center', display: 'block' }}
            >
              ⬇ Baixar vídeo
            </a>
            <div style={{ fontSize: 9, color: '#1e1e1e', wordBreak: 'break-all', fontFamily: 'monospace', textAlign: 'center' }}>
              {data.videoUrl?.split('/').pop()}
            </div>
          </>
        )}
      </div>

      <Handle type="target" position={Position.Left} id="video" className="handle-video" />
    </div>
  )
}
