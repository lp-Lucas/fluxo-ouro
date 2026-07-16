'use client';

import { useCallback, useState } from 'react';

interface Props {
  onUpload: (base64: string, mimeType: string) => void;
  isLoading: boolean;
}

export default function ImageUpload({ onUpload, isLoading }: Props) {
  const [preview, setPreview] = useState<string | null>(null);

  const handleFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        setPreview(dataUrl);
        const [, b64] = dataUrl.split(',');
        onUpload(b64, file.type || 'image/png');
      };
      reader.readAsDataURL(file);
    },
    [onUpload],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file?.type.startsWith('image/')) handleFile(file);
    },
    [handleFile],
  );

  return (
    <div className="flex flex-col h-full p-3 gap-3">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
        Motion Editor
      </div>

      <label
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        className="relative flex flex-col items-center justify-center border-2 border-dashed border-gray-700 rounded-lg p-4 cursor-pointer hover:border-indigo-500 transition-colors"
        style={{ minHeight: 130 }}
      >
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        {preview ? (
          <img src={preview} alt="preview" className="max-h-24 max-w-full object-contain rounded" />
        ) : (
          <>
            <svg className="w-8 h-8 text-gray-600 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span className="text-xs text-gray-500 text-center">Solte uma imagem ou clique</span>
          </>
        )}
        {isLoading && (
          <div className="absolute inset-0 bg-gray-900/80 rounded-lg flex items-center justify-center">
            <div className="text-xs text-indigo-400">Gerando HTML...</div>
          </div>
        )}
      </label>
    </div>
  );
}
