/**
 * FUNDAMENTOS DE DESIGN — anexados a TODO prompt do gpt-image (server.ts /api/flow/design).
 * Destilado do MotionIA/DESIGN_RULES.md (28 referências analisadas): espaçamento, margem,
 * tipografia, hierarquia e qualidade CGI. É brand-agnostic — cores/identidade vêm das
 * referências e da descrição do usuário; aqui só entram os princípios universais que
 * separam um resultado premium de um "template Canva".
 *
 * ATENÇÃO: mudanças aqui mudam o hash de cache dos designs (imagens serão regeradas).
 */
export const DESIGN_SPEC = `
DESIGN FUNDAMENTALS (always apply — these rules override style whims):

SAFE MARGINS — THE MOST IMPORTANT RULE:
- Every element (text, cards, graphics, figures) stays at least 8% away from ALL four frame edges. NOTHING touches, hugs or gets cropped by the frame border — no cut-off letters, no cards bleeding out, no graphics kissing the edge. Compose INSIDE an imaginary inner frame with generous padding all around.

COMPOSITION & SPACING:
- The composition must BREATHE: leave a clear rest zone (10-15% of the frame) between the text block and the main visual element. Empty space is part of the design, not waste.
- ONE focal element only — a single clear answer to "where do I look first?". Supporting elements are smaller, placed around it, never competing.
- Keep the bottom of the frame clean and uncluttered.

BACKGROUND FIDELITY:
- Reproduce the background of the brand/style reference EXACTLY as it is: if it is a gradient, recreate the SAME gradient (same direction, same tones, same softness) — never simplify a gradient into a flat solid color. If it is flat, keep it flat. The background is part of the identity.

TYPOGRAPHY:
- Clean geometric sans-serif (SF Pro Display style). No serif, no decorative fonts.
- TWO weights only, strong contrast: light/regular gray build-up lines + one heavy/black punch line about twice as large, tight tracking. Never three or more weights.
- Left-aligned text block. The text never spans edge to edge: max ~65% of the frame width, never touching the right edge.
- No box, no shadow, no outline, no glow and no gradient on letters — type floats clean on the background.
- Comfortable line-height; lines never cramped or overlapping. Punctuation is part of the design.
- Text in Portuguese keeps ALL accents exactly as written (ção, é, ê, ã) — never drop accents.

SURFACES & ELEMENTS:
- Consistent corner radii: cards ~16-22px, small inner icons ~10-14px, buttons/badges fully rounded (pill). Inner elements always have smaller radius than their container.
- Card-like panels are pure floating software surfaces — NO device bezel, no phone/tablet hardware, no physical thickness, no buttons or camera.
- Max 3 content items inside any card (label, hero value, one detail/graphic).

QUALITY & LIGHT:
- Photorealistic CGI render quality, like an Apple keynote slide — NOT flat graphic design, not a Canva template.
- Soft diffuse shadows (large radius, low opacity), subtle depth between layers, materials that react to light.
- One coherent color system for the whole image; at most ONE accent color. No random extra hues.

PROHIBITIONS:
- Do NOT imagine or invent ANYTHING that was not asked for: no invented logos, brand marks, wordmarks, badges, extra text, labels, numbers or decorative elements beyond the requested copy and the provided references.
- No watermark, no UI chrome, no clutter, no fire/neon without purpose, no centered edge-to-edge text.
`.trim();

/** Linha extra quando NÃO há logo anexada — o gpt-image adora inventar uma. */
export const NO_LOGO_RULE =
  "\n- THIS DESIGN HAS NO LOGO: do not add, draw or invent any logo, brand mark, wordmark, monogram or app icon anywhere in the image.";
