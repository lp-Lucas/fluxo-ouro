import { useCallback, useEffect } from 'react'
import {
  ReactFlow, Background, Controls, MiniMap, Panel,
  addEdge, useNodesState, useEdgesState, ReactFlowProvider,
  MarkerType,
} from '@xyflow/react'

import ImageInputNode  from './nodes/ImageInputNode.jsx'
import PromptNode      from './nodes/PromptNode.jsx'
import ModelNode       from './nodes/ModelNode.jsx'
import GenerateNode    from './nodes/GenerateNode.jsx'
import VideoPreviewNode from './nodes/VideoPreviewNode.jsx'

const nodeTypes = {
  imageInput: ImageInputNode,
  prompt:     PromptNode,
  model:      ModelNode,
  generate:   GenerateNode,
  preview:    VideoPreviewNode,
}

const EDGE_COLORS = {
  prompt: '#0033ff',
  image:  '#22cc66',
  config: '#9933ff',
  video:  '#ff6600',
}

const makeEdge = (id, src, srcH, tgt, tgtH) => ({
  id,
  source: src, sourceHandle: srcH,
  target: tgt, targetHandle: tgtH,
  animated: true,
  style: { stroke: EDGE_COLORS[srcH] || '#333', strokeWidth: 2 },
  markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLORS[srcH] || '#333', width: 10, height: 10 },
})

const INIT_NODES = [
  { id: 'prompt-1',  type: 'prompt',     position: { x: 60,  y: 40  }, data: { text: '' } },
  { id: 'image-1',   type: 'imageInput', position: { x: 60,  y: 310 }, data: {} },
  { id: 'model-1',   type: 'model',      position: { x: 60,  y: 540 }, data: {} },
  { id: 'gen-1',     type: 'generate',   position: { x: 460, y: 200 }, data: {} },
  { id: 'preview-1', type: 'preview',    position: { x: 870, y: 100 }, data: {} },
]

const INIT_EDGES = [
  makeEdge('e1', 'prompt-1', 'prompt', 'gen-1',     'prompt'),
  makeEdge('e2', 'image-1',  'image',  'gen-1',     'image'),
  makeEdge('e3', 'model-1',  'config', 'gen-1',     'config'),
  makeEdge('e4', 'gen-1',    'video',  'preview-1', 'video'),
]

function cleanForLoad(nodes) {
  return nodes.map(n => {
    const data = { ...n.data }
    if (data.status === 'running') data.status = 'idle'
    if (data.previewUrl?.startsWith('blob:')) {
      data.previewUrl = null
      data.uploadId   = ''
      data.status     = 'idle'
    }
    return { ...n, data }
  })
}

function FlowCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState(INIT_NODES)
  const [edges, setEdges, onEdgesChange] = useEdgesState(INIT_EDGES)

  useEffect(() => {
    try {
      const raw = localStorage.getItem('motionIA_flow_v2')
      if (raw) {
        const { nodes: n, edges: e } = JSON.parse(raw)
        if (Array.isArray(n) && n.length) {
          setNodes(cleanForLoad(n))
          setEdges(e || [])
        }
      }
    } catch {}
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('motionIA_flow_v2', JSON.stringify({ nodes, edges }))
    } catch {}
  }, [nodes, edges])

  const onConnect = useCallback(params => {
    const color = EDGE_COLORS[params.sourceHandle] || '#333'
    setEdges(eds => addEdge({
      ...params,
      animated: true,
      style: { stroke: color, strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 10, height: 10 },
    }, eds))
  }, [setEdges])

  const addNode = useCallback(type => {
    const id = `${type}-${Date.now()}`
    const initData = type === 'prompt' ? { text: '' } : {}
    setNodes(ns => [...ns, {
      id,
      type,
      position: { x: 280 + Math.random() * 180, y: 220 + Math.random() * 180 },
      data: initData,
    }])
  }, [setNodes])

  const resetFlow = useCallback(() => {
    if (!window.confirm('Resetar para o fluxo inicial?')) return
    setNodes(INIT_NODES)
    setEdges(INIT_EDGES)
  }, [setNodes, setEdges])

  const saveFlow = useCallback(async () => {
    await fetch('/api/save-flow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes, edges }),
    })
    // brief visual feedback via title flash
    const t = document.title
    document.title = '✓ Salvo — FlowStudio'
    setTimeout(() => { document.title = t }, 1500)
  }, [nodes, edges])

  const loadFlow = useCallback(async () => {
    const res  = await fetch('/api/load-flow')
    const data = await res.json()
    if (data?.nodes?.length) {
      setNodes(cleanForLoad(data.nodes))
      setEdges(data.edges || [])
    }
  }, [setNodes, setEdges])

  const NODE_DEFS = [
    { type: 'imageInput', label: '📁 Imagem',  color: '#1a5c34' },
    { type: 'prompt',     label: '✏️ Prompt',  color: '#0033cc' },
    { type: 'model',      label: '🎬 Modelo',  color: '#5c1a8c' },
    { type: 'generate',   label: '⚡ Gerar',   color: '#b84a00' },
    { type: 'preview',    label: '▶ Preview',  color: '#1a1a1a' },
  ]

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        snapToGrid
        snapGrid={[20, 20]}
        defaultViewport={{ x: 60, y: 40, zoom: 0.85 }}
        minZoom={0.15}
        maxZoom={2.5}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background variant="dots" gap={24} size={1.2} color="#1c1c1c" />
        <Controls />
        <MiniMap
          nodeColor={n => {
            const m = { imageInput:'#1a5c34', prompt:'#0033cc', model:'#5c1a8c', generate:'#b84a00', preview:'#1a1a1a' }
            return m[n.type] || '#222'
          }}
          maskColor="rgba(8,8,8,0.8)"
        />

        <Panel position="top-left">
          <div className="fs-panel nodrag">
            <div className="fs-logo">Motion<span>IA</span> Flow</div>

            <div className="fs-section">Adicionar Nó</div>
            {NODE_DEFS.map(n => (
              <button
                key={n.type}
                className="fs-node-btn"
                style={{ color: n.color, borderLeftColor: n.color }}
                onClick={() => addNode(n.type)}
              >
                {n.label}
              </button>
            ))}

            <div className="fs-divider" />

            <button className="fs-action-btn" onClick={saveFlow}>💾 Salvar fluxo</button>
            <button className="fs-action-btn" onClick={loadFlow}>📂 Carregar fluxo</button>
            <button className="fs-action-btn danger" onClick={resetFlow}>↺ Resetar</button>

            <div className="fs-divider" />
            <div style={{ fontSize: 10, color: '#222', lineHeight: 1.6 }}>
              Del — apagar seleção<br/>
              Scroll — zoom<br/>
              Arraste handle → handle
            </div>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  )
}

export default function App() {
  return (
    <ReactFlowProvider>
      <FlowCanvas />
    </ReactFlowProvider>
  )
}
