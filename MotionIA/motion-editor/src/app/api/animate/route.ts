import { NextRequest } from 'next/server';
import { askClaude } from '@/lib/claude-cli';

export async function POST(req: NextRequest) {
  try {
    const { elementId, elementHtml, description } = await req.json();

    const prompt = `You are a Remotion animation expert. Generate animation parameters for a UI element.

Element ID: ${elementId}
Element HTML snippet: ${elementHtml.slice(0, 400)}
Animation request: "${description}"

Return ONLY a valid JSON object (no explanation, no markdown) with this exact structure:
{
  "elementId": "${elementId}",
  "durationFrames": 60,
  "animations": [
    {
      "property": "translateY",
      "from": 80,
      "to": 0,
      "unit": "px",
      "startFrame": 0,
      "endFrame": 25,
      "type": "spring"
    }
  ]
}

Property options: "translateY", "translateX", "scale", "opacity", "rotate", "scaleX", "scaleY"
Type options: "spring" (bouncy/organic), "ease" (linear interpolation)
Units: "px" for translate, "deg" for rotate, "" for scale and opacity

Common patterns:
- "surge de baixo" / "bounce up": translateY from=80 to=0 unit="px" spring + opacity from=0 to=1 unit="" ease
- "surge do lado" / "slide in": translateX from=-80 to=0 spring + opacity 0→1
- "escala" / "pop in": scale from=0.2 to=1 spring + opacity 0→1
- "fade": opacity from=0 to=1 ease endFrame=20
- "gira" / "rotate": rotate from=180 to=0 spring
- Keep durationFrames between 30-90
- Multiple animations on same element run simultaneously`;

    const raw = await askClaude(prompt);

    // Extract JSON
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude did not return valid JSON');

    const config = JSON.parse(jsonMatch[0]);
    return Response.json(config);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
