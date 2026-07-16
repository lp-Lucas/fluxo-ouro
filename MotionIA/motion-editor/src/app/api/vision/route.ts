import { NextRequest } from 'next/server';
import { parse } from 'node-html-parser';
import { askClaudeWithImage } from '@/lib/claude-cli';

const PROMPT = `You are a UI-to-HTML expert. Look at the image at the file path provided.

Generate a COMPLETE, self-contained HTML file that visually recreates this interface.

CRITICAL RULES:
1. Assign data-element-id to EVERY visible element — no exceptions:
   - Colored rectangles, blocks, background shapes (even if they only have a fill color)
   - Buttons, links, inputs
   - Headings, paragraphs, any text node
   - Images, icons, badges, cards
   - Dividers, separators, decorative shapes
   Use sequential IDs: data-element-id="el-1", data-element-id="el-2", etc.
   *** NEVER assign data-element-id to the outermost root wrapper (id="root") or to
   containers whose only purpose is layout alignment. Tag the CONTENT elements. ***
2. Use a <style> block inside <head> for all CSS
3. Reproduce EXACT colors, fonts, sizes, spacing, gradients, shadows, border-radius
4. Root container must have id="root" with fixed width/height matching the image aspect ratio
5. Set body { margin:0; padding:0; overflow:hidden }
6. Use Google Fonts @import if needed
7. Output ONLY valid HTML starting with <!DOCTYPE html> — no markdown, no explanation`;

const SKIP_TAGS = new Set(['html', 'head', 'body', 'style', 'script', 'meta', 'link', 'title', 'noscript']);
const ALWAYS_TAG = new Set(['img', 'button', 'input', 'select', 'textarea', 'video', 'canvas', 'svg']);
const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'label', 'li', 'td', 'th', 'caption', 'figcaption', 'blockquote']);

/**
 * Post-process: assign data-element-id to any visible element Claude missed.
 * Targets: background/border blocks, always-interactive elements, and text nodes.
 */
function autoTagElements(html: string): string {
  const root = parse(html);

  // Find the current max ID so we don't collide
  let maxId = 0;
  root.querySelectorAll('[data-element-id]').forEach((el) => {
    const n = parseInt((el.getAttribute('data-element-id') ?? '').replace(/^el-/, ''), 10);
    if (!isNaN(n) && n > maxId) maxId = n;
  });

  root.querySelectorAll('*').forEach((el) => {
    const tag = (el.tagName ?? '').toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (el.getAttribute('data-element-id')) return; // already labelled
    if (el.getAttribute('id') === 'root') return;   // skip root wrapper

    const style = el.getAttribute('style') ?? '';
    const hasBackground = /background/.test(style);
    const hasBorder = /border[\s-:]/.test(style);
    const hasBoxShadow = /box-shadow/.test(style);
    const hasText = (el.innerText ?? '').trim().length > 0;

    const shouldTag =
      ALWAYS_TAG.has(tag) ||
      hasBackground ||
      hasBorder ||
      hasBoxShadow ||
      (TEXT_TAGS.has(tag) && hasText);

    if (shouldTag) {
      el.setAttribute('data-element-id', `el-${++maxId}`);
    }
  });

  return root.toString();
}

export async function POST(req: NextRequest) {
  try {
    const { imageBase64, mimeType } = await req.json();
    if (!imageBase64) return Response.json({ error: 'No image provided' }, { status: 400 });

    const raw = await askClaudeWithImage(PROMPT, imageBase64, mimeType || 'image/png');

    // Strip markdown fences if Claude wraps the output
    let html = raw
      .replace(/^```html\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    // Auto-tag any remaining untagged visual elements
    html = autoTagElements(html);

    return Response.json({ html });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
