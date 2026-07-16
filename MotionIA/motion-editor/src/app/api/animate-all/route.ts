import { NextRequest } from 'next/server';
import { askClaude } from '@/lib/claude-cli';

interface Element {
  id: string;
  tag: string;
  text: string;
}

export async function POST(req: NextRequest) {
  try {
    const { elements, description } = await req.json() as {
      elements: Element[];
      description: string;
    };

    if (!elements?.length) return Response.json({ error: 'No elements' }, { status: 400 });
    if (!description) return Response.json({ error: 'No description' }, { status: 400 });

    const elementList = elements
      .map((e, i) => `  ${i + 1}. id="${e.id}"  tag=<${e.tag}>  text="${e.text}"`)
      .join('\n');

    const prompt = `You are a Remotion animation choreographer for a UI design tool.

Animate ALL of these ${elements.length} UI elements according to the style description.

ELEMENTS (in visual/document order):
${elementList}

ANIMATION REQUEST: "${description}"

RULES:
- Return exactly one config per element, in the SAME ORDER as the list above
- Use stagger: increment startFrame by a consistent delay (e.g. 5–8 frames) for each successive element
- Property options: "translateY", "translateX", "scale", "opacity", "rotate", "scaleX", "scaleY"
- Type options: "spring" (bouncy/organic feel), "ease" (smooth linear interpolation)
- Units: "px" for translate, "deg" for rotate, "" for scale and opacity
- Always pair movement with an opacity animation for natural feel
- durationFrames = (last animation's endFrame) + 15 for that element
- Keep the animation tight: each element's core animation should be 15–30 frames
- Total stagger chain should finish within ~120 frames

Return ONLY a valid JSON array — no markdown, no explanation:
[
  {
    "elementId": "el-1",
    "durationFrames": 60,
    "animations": [
      { "property": "translateY", "from": 40, "to": 0, "unit": "px", "startFrame": 0, "endFrame": 22, "type": "spring" },
      { "property": "opacity",    "from": 0,  "to": 1, "unit": "",   "startFrame": 0, "endFrame": 18, "type": "ease" }
    ]
  }
]`;

    const raw = await askClaude(prompt);

    // Extract JSON array from response
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Claude did not return a valid JSON array');

    const configs = JSON.parse(match[0]);
    if (!Array.isArray(configs)) throw new Error('Expected JSON array');

    return Response.json({ configs });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
