'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import type { AnimationConfig } from '@/remotion/HtmlAnimator';
import type { EditorMode } from './Toolbar';
import { computeFrameState, type ElementClip } from '@/lib/animation';

export interface CanvasSize { w: number; h: number }

export interface ElemComputedStyle {
  width: string; height: string;
  backgroundColor: string; color: string;
  fontSize: string; borderRadius: string;
}

interface Props {
  html: string;
  animationConfigs: AnimationConfig[];
  selectedElementId: string | null;
  mode: EditorMode;
  videoUrl?: string | null;
  canvasSize: CanvasSize;
  currentFrame?: number;
  elementClips?: ElementClip[];
  totalFrames?: number;
  onSelectElement: (el: { id: string; html: string; computedStyle?: ElemComputedStyle } | null) => void;
  onHtmlChange: (html: string) => void;
  onAddAt: (x: number, y: number) => void;
}

export interface HtmlCanvasHandle {
  insertElement: (elementHtml: string, x: number, y: number) => void;
}

// Injected at the end of every mode's script — handles live setFrame preview messages.
// Captures each element's original transform before any animation is applied so we can
// compose animation transforms on top without clobbering position (e.g. from move tool).
const SET_FRAME_JS = `
document.querySelectorAll('[data-element-id]').forEach(function(el){
  el.setAttribute('data-bt',el.style.transform||'');
});
window.addEventListener('message',function(e){
  if(!e.data||e.data.type!=='setFrame')return;
  (e.data.visibility||[]).forEach(function(v){
    var el=document.querySelector('[data-element-id="'+v.id+'"]');
    if(!el)return;
    if(v.visible){el.style.removeProperty('display')}
    else{
      el.style.setProperty('display','none','important');
      if(typeof _removeHandles==='function')_removeHandles();
    }
  });
  (e.data.styles||[]).forEach(function(s){
    var el=document.querySelector('[data-element-id="'+s.id+'"]');
    if(!el)return;
    for(var k in s.props){
      if(k==='transform'){
        var bt=el.getAttribute('data-bt')||'';
        el.style.setProperty('transform',bt?bt+' '+s.props[k]:s.props[k],'important');
      }else{
        el.style.setProperty(k,s.props[k],'important');
      }
    }
  });
});`;

function buildContent(
  html: string,
  animationConfigs: AnimationConfig[],
  mode: EditorMode,
  transparentBg: boolean,
): string {
  const animatedIds = JSON.stringify(animationConfigs.map((c) => c.elementId));

  const base = `
    [data-element-id]{box-sizing:border-box}
    ${transparentBg ? 'html,body{background:transparent!important}#root{background:transparent!important}' : ''}`;

  const css: Record<EditorMode, string> = {
    select: `
      [data-element-id]{cursor:pointer}
      [data-element-id]:hover{outline:2px solid rgba(99,102,241,.8)!important;outline-offset:1px}
      [data-element-id].selected{outline:2px solid #6366f1!important;outline-offset:1px}
      [data-element-id].animated{outline:1px solid rgba(16,185,129,.4)}`,
    move: `
      [data-element-id]{cursor:grab}
      [data-element-id]:hover{outline:2px solid rgba(14,165,233,.7)!important;outline-offset:1px}
      [data-element-id].dragging{cursor:grabbing!important;outline:2px solid #0ea5e9!important;z-index:9999;position:relative}`,
    delete: `
      [data-element-id]{cursor:pointer}
      [data-element-id]:hover{outline:2px solid rgba(239,68,68,.8)!important;outline-offset:1px;background:rgba(239,68,68,.06)!important}`,
    add: `body{cursor:crosshair}`,
  };

  const js: Record<EditorMode, string> = {
    select: `
      var _sel=null,_resizing=null,_rDir='',_rSx=0,_rSy=0,_rW=0,_rH=0;
      var ids=${animatedIds};

      function _clean(){
        var c=document.documentElement.cloneNode(true);
        c.querySelectorAll('[data-motion-injected]').forEach(function(e){e.remove()});
        return '<!DOCTYPE html>\\n'+c.outerHTML;
      }
      function _removeHandles(){
        document.querySelectorAll('[data-resize-handle]').forEach(function(h){h.remove()});
      }
      function _addHandles(el){
        _removeHandles();
        var r=el.getBoundingClientRect();
        [['nw',r.left-5,r.top-5,'nw-resize'],
         ['ne',r.right-5,r.top-5,'ne-resize'],
         ['sw',r.left-5,r.bottom-5,'sw-resize'],
         ['se',r.right-5,r.bottom-5,'se-resize']].forEach(function(d){
          var h=document.createElement('div');
          h.setAttribute('data-resize-handle',d[0]);
          h.setAttribute('data-motion-injected','true');
          h.style.cssText='position:fixed;width:10px;height:10px;background:#6366f1;border:2px solid #fff;border-radius:2px;z-index:99999;box-sizing:border-box;left:'+d[1]+'px;top:'+d[2]+'px;cursor:'+d[3];
          document.body.appendChild(h);
        });
      }

      ids.forEach(function(id){
        var el=document.querySelector('[data-element-id="'+id+'"]');
        if(el)el.classList.add('animated');
      });

      document.addEventListener('mousedown',function(e){
        var rh=e.target&&e.target.getAttribute&&e.target.getAttribute('data-resize-handle');
        if(rh&&_sel){
          e.preventDefault();e.stopPropagation();
          _resizing=_sel;_rDir=rh;
          _rSx=e.clientX;_rSy=e.clientY;
          _rW=_resizing.offsetWidth;_rH=_resizing.offsetHeight;
          return;
        }
        var el=e.target.closest&&e.target.closest('[data-element-id]');
        if(!el)return;
        e.preventDefault();e.stopPropagation();
        document.querySelectorAll('[data-element-id].selected').forEach(function(x){x.classList.remove('selected')});
        el.classList.add('selected');
        _sel=el;
        _addHandles(el);
        var cs=window.getComputedStyle(el);
        window.parent.postMessage({
          type:'elementSelected',
          id:el.getAttribute('data-element-id'),
          html:el.outerHTML.slice(0,800),
          cs:{w:cs.width,h:cs.height,bg:cs.backgroundColor,fg:cs.color,fs:cs.fontSize,br:cs.borderRadius}
        },'*');
      },true);

      document.addEventListener('mousemove',function(e){
        if(!_resizing)return;
        var dx=e.clientX-_rSx,dy=e.clientY-_rSy;
        var nw=_rW,nh=_rH;
        if(_rDir.indexOf('e')>=0)nw=Math.max(20,_rW+dx);
        if(_rDir.indexOf('w')>=0)nw=Math.max(20,_rW-dx);
        if(_rDir.indexOf('s')>=0)nh=Math.max(20,_rH+dy);
        if(_rDir.indexOf('n')>=0)nh=Math.max(20,_rH-dy);
        _resizing.style.width=nw+'px';
        _resizing.style.height=nh+'px';
        _addHandles(_resizing);
      });

      document.addEventListener('mouseup',function(){
        if(!_resizing)return;
        _resizing=null;
        window.parent.postMessage({type:'htmlChanged',html:_clean()},'*');
      });

      window.addEventListener('message',function(e){
        if(!e.data||e.data.type!=='refreshHandles')return;
        var el=document.querySelector('[data-element-id="'+e.data.id+'"]');
        if(el){_sel=el;_addHandles(el)}
      });`,

    move: `
      var _drag=null,_sx=0,_sy=0,_bx=0,_by=0;
      function _getTx(el){
        var m=(el.style.transform||'').match(/translate\\((-?[\\d.]+)px,(-?[\\d.]+)px\\)/);
        return m?[parseFloat(m[1]),parseFloat(m[2])]:[0,0];
      }
      function _clean(){
        var c=document.documentElement.cloneNode(true);
        c.querySelectorAll('[data-motion-injected]').forEach(function(e){e.remove()});
        return '<!DOCTYPE html>\\n'+c.outerHTML;
      }
      document.addEventListener('mousedown',function(e){
        var el=e.target.closest('[data-element-id]');
        if(!el)return;
        e.preventDefault();e.stopPropagation();
        _drag=el;_sx=e.clientX;_sy=e.clientY;
        var b=_getTx(el);_bx=b[0];_by=b[1];
        el.classList.add('dragging');
      },true);
      document.addEventListener('mousemove',function(e){
        if(!_drag)return;
        _drag.style.transform='translate('+(_bx+e.clientX-_sx)+'px,'+(_by+e.clientY-_sy)+'px)';
      });
      document.addEventListener('mouseup',function(e){
        if(!_drag)return;
        _drag.style.transform='translate('+(_bx+e.clientX-_sx)+'px,'+(_by+e.clientY-_sy)+'px)';
        _drag.classList.remove('dragging');
        _drag=null;
        window.parent.postMessage({type:'htmlChanged',html:_clean()},'*');
      });`,

    delete: `
      function _clean(){
        var c=document.documentElement.cloneNode(true);
        c.querySelectorAll('[data-motion-injected]').forEach(function(e){e.remove()});
        return '<!DOCTYPE html>\\n'+c.outerHTML;
      }
      document.addEventListener('click',function(e){
        var el=e.target.closest('[data-element-id]');
        if(!el)return;
        e.preventDefault();e.stopPropagation();
        el.remove();
        window.parent.postMessage({type:'htmlChanged',html:_clean()},'*');
      });`,

    add: `
      function _clean(){
        var c=document.documentElement.cloneNode(true);
        c.querySelectorAll('[data-motion-injected]').forEach(function(e){e.remove()});
        return '<!DOCTYPE html>\\n'+c.outerHTML;
      }
      document.addEventListener('click',function(e){
        if(e.target.closest('[data-element-id]'))return;
        window.parent.postMessage({type:'addAt',x:e.clientX,y:e.clientY},'*');
      });
      window.addEventListener('message',function(e){
        if(!e.data||e.data.type!=='insertElement')return;
        var div=document.createElement('div');
        div.innerHTML=e.data.html;
        var el=div.firstElementChild;
        if(!el)return;
        el.style.position='absolute';
        el.style.left=e.data.x+'px';
        el.style.top=e.data.y+'px';
        el.style.zIndex='1';
        document.body.style.position='relative';
        document.body.appendChild(el);
        window.parent.postMessage({type:'htmlChanged',html:_clean()},'*');
      });`,
  };

  return `${html}
<style data-motion-injected="true">
${base}
${css[mode]}
</style>
<script data-motion-injected="true">
(function(){
${js[mode]}
${SET_FRAME_JS}
})();
</script>`;
}

const HtmlCanvas = forwardRef<HtmlCanvasHandle, Props>(function HtmlCanvas(
  {
    html, animationConfigs, selectedElementId, mode, videoUrl, canvasSize,
    currentFrame, elementClips, totalFrames,
    onSelectElement, onHtmlChange, onAddAt,
  },
  ref,
) {
  const iframeRef      = useRef<HTMLIFrameElement>(null);
  const skipNextRender = useRef(false);
  const selectedIdRef  = useRef<string | null>(null);
  const transparentBg  = !!videoUrl;

  // Keep refs in sync for use inside effects without adding them as deps
  const currentFrameRef    = useRef<number | undefined>(undefined);
  const sendFrameStateRef  = useRef<((win: Window, frame: number) => void) | null>(null);

  useEffect(() => { selectedIdRef.current = selectedElementId; }, [selectedElementId]);
  useEffect(() => { currentFrameRef.current = currentFrame; }, [currentFrame]);

  useImperativeHandle(ref, () => ({
    insertElement(elementHtml, x, y) {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'insertElement', html: elementHtml, x, y },
        '*',
      );
    },
  }));

  // Compute and send frame state to iframe
  const sendFrameState = useCallback((win: Window, frame: number) => {
    const clips = elementClips ?? [];
    const tf    = totalFrames ?? 90;
    const state = computeFrameState(animationConfigs, clips, frame, tf);
    win.postMessage({ type: 'setFrame', ...state }, '*');
  }, [animationConfigs, elementClips, totalFrames]);

  // Keep ref up-to-date so the re-render effect can call it without stale closure
  useEffect(() => { sendFrameStateRef.current = sendFrameState; }, [sendFrameState]);

  // Re-render iframe when html / mode / animationConfigs change
  useEffect(() => {
    if (skipNextRender.current) { skipNextRender.current = false; return; }
    const iframe = iframeRef.current;
    if (!iframe || !html) return;
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(buildContent(html, animationConfigs, mode, transparentBg));
    doc.close();
    if (mode === 'select' && selectedIdRef.current) {
      doc.querySelector(`[data-element-id="${selectedIdRef.current}"]`)?.classList.add('selected');
      iframe.contentWindow?.postMessage({ type: 'refreshHandles', id: selectedIdRef.current }, '*');
    }
    // Re-apply frame state after re-render (scripts need one tick to register listeners)
    const win = iframe.contentWindow;
    setTimeout(() => {
      const frame = currentFrameRef.current;
      if (win && frame !== undefined) sendFrameStateRef.current?.(win, frame);
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, mode, animationConfigs, transparentBg]);

  // Sync selection highlight when selected element changes
  useEffect(() => {
    if (mode !== 'select') return;
    const iframe = iframeRef.current;
    const doc    = iframe?.contentDocument;
    if (!doc) return;
    doc.querySelectorAll('[data-element-id].selected').forEach((el) => el.classList.remove('selected'));
    if (selectedElementId) {
      doc.querySelector(`[data-element-id="${selectedElementId}"]`)?.classList.add('selected');
      iframe?.contentWindow?.postMessage({ type: 'refreshHandles', id: selectedElementId }, '*');
    }
  }, [selectedElementId, mode]);

  // Send updated frame state when currentFrame or animation data changes
  useEffect(() => {
    if (currentFrame === undefined) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    sendFrameState(win, currentFrame);
  }, [currentFrame, sendFrameState]);

  // Listen for messages from the iframe
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data?.type) return;
      if (e.data.type === 'elementSelected') {
        const raw = e.data.cs;
        onSelectElement({
          id: e.data.id,
          html: e.data.html,
          computedStyle: raw ? {
            width: raw.w, height: raw.h,
            backgroundColor: raw.bg, color: raw.fg,
            fontSize: raw.fs, borderRadius: raw.br,
          } : undefined,
        });
      } else if (e.data.type === 'htmlChanged') {
        skipNextRender.current = true;
        onHtmlChange(e.data.html);
      } else if (e.data.type === 'addAt') {
        onAddAt(e.data.x, e.data.y);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onSelectElement, onHtmlChange, onAddAt]);

  const modeLabel: Record<EditorMode, string> = {
    select: 'clique para selecionar • arraste os cantos para redimensionar',
    move:   'arraste para mover',
    delete: 'clique para excluir',
    add:    'clique no canvas para posicionar',
  };

  const { w, h } = canvasSize;

  if (!html && !videoUrl) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
        <div className="text-center">
          <div className="text-4xl mb-3">🎬</div>
          <div>Importe um vídeo ou faça upload de uma imagem para começar</div>
          <div className="text-xs mt-1 text-gray-700">Claude vai gerar o HTML da interface</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-gray-900 p-6 flex justify-center items-start">
      <div className="shadow-2xl">
        <div className="bg-gray-800 px-3 py-1.5 rounded-t flex items-center gap-1.5" style={{ width: w }}>
          <div className="w-3 h-3 rounded-full bg-red-500/70" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
          <div className="w-3 h-3 rounded-full bg-green-500/70" />
          <span className="text-xs text-gray-500 ml-2">
            {videoUrl && '🎬 '}
            {modeLabel[mode]}
          </span>
          {videoUrl && <span className="ml-auto text-[10px] text-sky-500 font-medium">modo vídeo</span>}
        </div>

        <div className="relative" style={{ width: w, height: h }}>
          {videoUrl && (
            <video
              key={videoUrl}
              src={videoUrl}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              muted autoPlay loop playsInline
            />
          )}
          {html && (
            <iframe
              ref={iframeRef}
              {...({'allowtransparency': transparentBg ? 'true' : undefined} as object)}
              style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%',
                border: 'none', display: 'block',
                background: transparentBg ? 'transparent' : 'white',
              }}
              sandbox="allow-scripts allow-same-origin"
              title="UI Preview"
            />
          )}
          {!html && videoUrl && (
            <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)' }}>
              <div className="text-center text-white">
                <div className="text-sm font-medium mb-1">Vídeo carregado</div>
                <div className="text-xs text-white/60">Faça upload de uma imagem para gerar o overlay</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default HtmlCanvas;
