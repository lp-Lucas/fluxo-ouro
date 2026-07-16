'use client';

export interface Layer {
  id: string;
  tag: string;
  text: string;
  outerHtml: string;
}

// Visual color per tag family
const TAG_COLOR: Record<string, string> = {
  h1: '#7c3aed', h2: '#7c3aed', h3: '#7c3aed', h4: '#7c3aed', h5: '#7c3aed', h6: '#7c3aed',
  p: '#4b5563', span: '#4b5563',
  button: '#2563eb', a: '#0891b2', input: '#0891b2', select: '#0891b2',
  img: '#059669', svg: '#059669', video: '#059669', canvas: '#059669',
  div: '#d97706', section: '#d97706', article: '#d97706', aside: '#d97706',
  li: '#6b7280', ul: '#6b7280', ol: '#6b7280',
};

const TAG_ABBR: Record<string, string> = {
  h1: 'H1', h2: 'H2', h3: 'H3', h4: 'H4', h5: 'H5', h6: 'H6',
  p: 'P', span: 'T', div: '▣', section: '▣', article: '▣', aside: '▣',
  button: 'B', a: 'A', input: 'I', select: 'S',
  img: '⬛', svg: '⬛', video: '▶', canvas: '◻',
  ul: 'L', ol: 'L', li: '·',
};

interface Props {
  layers: Layer[];
  animatedIds: Set<string>;
  selectedId: string | null;
  onSelect: (layer: Layer) => void;
}

export default function LayersPanel({ layers, animatedIds, selectedId, onSelect }: Props) {
  if (layers.length === 0) return null;

  return (
    <div className="flex flex-col min-h-0">
      <div className="px-3 pt-3 pb-1 flex items-center justify-between shrink-0">
        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
          Camadas
        </span>
        <span className="text-[10px] text-gray-700">{layers.length} elementos</span>
      </div>

      <div className="overflow-y-auto flex flex-col gap-0.5 px-2 pb-2">
        {layers.map((layer) => {
          const isAnimated = animatedIds.has(layer.id);
          const isSelected = selectedId === layer.id;
          const color = TAG_COLOR[layer.tag] ?? '#6b7280';
          const abbr = TAG_ABBR[layer.tag] ?? layer.tag.slice(0, 2).toUpperCase();

          return (
            <button
              key={layer.id}
              onClick={() => onSelect(layer)}
              className={`flex items-center gap-1.5 px-2 py-1.5 rounded text-left w-full transition-colors group ${
                isSelected
                  ? 'bg-indigo-950/60 ring-1 ring-indigo-600/50'
                  : 'hover:bg-gray-800/60'
              }`}
            >
              {/* Tag badge */}
              <span
                className="text-[9px] font-bold px-1 py-px rounded shrink-0 text-white"
                style={{ background: color, minWidth: 18, textAlign: 'center' }}
              >
                {abbr}
              </span>

              {/* ID */}
              <span className="text-[10px] font-mono text-gray-500 shrink-0">{layer.id}</span>

              {/* Text preview */}
              <span className="text-[10px] text-gray-600 truncate flex-1 group-hover:text-gray-400">
                {layer.text || '—'}
              </span>

              {/* Animated indicator */}
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: isAnimated ? '#34d399' : '#374151' }}
                title={isAnimated ? 'animado' : 'sem animação'}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Extract all data-element-id elements from an HTML string (client-side only). */
export function extractLayers(html: string): Layer[] {
  if (typeof window === 'undefined' || !html) return [];
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(doc.querySelectorAll('[data-element-id]')).map((el) => ({
      id: el.getAttribute('data-element-id') ?? '',
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30),
      outerHtml: el.outerHTML.slice(0, 600),
    }));
  } catch {
    return [];
  }
}
