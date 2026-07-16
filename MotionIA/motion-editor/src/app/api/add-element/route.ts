import { NextRequest } from 'next/server';
import { askClaude } from '@/lib/claude-cli';

export async function POST(req: NextRequest) {
  try {
    const { description } = await req.json();
    if (!description) return Response.json({ error: 'No description' }, { status: 400 });

    const prompt = `Generate a single self-contained HTML element based on this description:
"${description}"

Rules:
- Output ONLY the HTML element — no <!DOCTYPE>, no <html>, no <body>, no extra wrappers
- Use inline styles only (no <style> blocks, no class names that need external CSS)
- Assign a unique data-element-id attribute: data-element-id="new-${Date.now()}"
- Use modern, visually polished styling (border-radius, box-shadow, gradients are fine)
- Use Google Fonts via @import if needed — but only if the description asks for a specific font
- Keep it compact — max width ~280px unless specified
- Use font-family: sans-serif by default
- Output nothing else — just the raw HTML element`;

    const raw = await askClaude(prompt);

    // Strip any accidental markdown fences
    const html = raw
      .replace(/^```html\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    return Response.json({ html });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
