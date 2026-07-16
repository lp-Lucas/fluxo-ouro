'use client';

export type EditorMode = 'select' | 'move' | 'delete' | 'add';

interface Tool {
  mode: EditorMode;
  label: string;
  icon: string;
  activeClass: string;
  hint: string;
}

const TOOLS: Tool[] = [
  { mode: 'select', label: 'Selecionar', icon: '↖', activeClass: 'bg-indigo-600 text-white', hint: 'Clique para selecionar e animar' },
  { mode: 'move',   label: 'Mover',      icon: '✥', activeClass: 'bg-sky-600 text-white',    hint: 'Arraste para reposicionar' },
  { mode: 'delete', label: 'Excluir',    icon: '✕', activeClass: 'bg-red-600 text-white',    hint: 'Clique para excluir' },
  { mode: 'add',    label: 'Adicionar',  icon: '+', activeClass: 'bg-emerald-600 text-white', hint: 'Configure no painel →' },
];

interface Props {
  mode: EditorMode;
  onChange: (mode: EditorMode) => void;
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

export default function Toolbar({ mode, onChange, disabled, canUndo, canRedo, onUndo, onRedo }: Props) {
  const active = TOOLS.find((t) => t.mode === mode);
  return (
    <div className="flex items-center gap-1.5 px-4 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
      {TOOLS.map((t) => (
        <button
          key={t.mode}
          onClick={() => onChange(t.mode)}
          disabled={disabled}
          title={t.hint}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-40 ${
            mode === t.mode
              ? t.activeClass
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
          }`}
        >
          <span className="text-sm leading-none">{t.icon}</span>
          {t.label}
        </button>
      ))}

      <div className="w-px h-4 bg-gray-700 mx-1" />

      <button
        onClick={onUndo}
        disabled={!canUndo || disabled}
        title="Desfazer (Ctrl+Z)"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        ↩ Desfazer
      </button>
      <button
        onClick={onRedo}
        disabled={!canRedo || disabled}
        title="Refazer (Ctrl+Shift+Z)"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        ↪ Refazer
      </button>

      {active && (
        <span className="ml-auto text-xs text-gray-600">{active.hint}</span>
      )}
    </div>
  );
}
