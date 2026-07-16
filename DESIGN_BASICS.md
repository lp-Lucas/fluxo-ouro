# DESIGN BASICS — Fundamentos aplicados a toda imagem do gpt-image
> Estes conceitos são anexados AUTOMATICAMENTE a todo prompt de design do FLOW
> (código-fonte: `backend/src/flow/designSpec.ts` — editar LÁ muda o comportamento;
> este arquivo é o espelho legível). Destilado do `MotionIA/DESIGN_RULES.md`
> (28 referências analisadas). São brand-agnostic: cores e identidade vêm das
> referências do projeto; aqui ficam só os princípios universais.

---

## 1. Margens de segurança (A REGRA MAIS IMPORTANTE)
- **Todo elemento** (texto, cards, gráficos, figuras) fica a pelo menos **8% de distância das 4 bordas**. NADA encosta, gruda ou é cortado pela borda — sem letra cortada, sem card sangrando pra fora. A composição vive dentro de um "frame interno" imaginário com padding generoso.

## 2. Composição e espaçamento
- **A composição respira**: zona de respiro clara (**10-15% do frame**) entre o bloco de texto e o elemento visual principal. Espaço vazio é parte do design, não desperdício.
- **UM elemento focal só** — uma resposta única pra "onde eu olho primeiro?". Elementos de suporte são menores, ficam ao redor, nunca competem.
- **Base do frame limpa** (últimos ~20%): sem poluição no rodapé.

## 2b. Fidelidade ao fundo
- O fundo da referência de identidade é reproduzido **exatamente como é**: degradê continua degradê (mesma direção, mesmos tons, mesma suavidade) — **nunca simplificar degradê em cor sólida**. Flat continua flat. O fundo é parte da identidade.

## 2. Tipografia
- Sans-serif geométrica limpa (estilo **SF Pro Display**). Sem serifa, sem fonte decorativa.
- **Dois pesos apenas**, contraste forte: linhas de build-up em light/regular cinza + **uma linha punch** em heavy/black ~2x maior, tracking apertado. Nunca três ou mais pesos.
- **Alinhado à esquerda**. O bloco de texto nunca vai de borda a borda: **máx. ~65% da largura**, nunca toca a borda direita.
- **Sem decoração na letra**: sem box, sombra, outline, glow ou gradiente — a tipografia flutua limpa no fundo.
- Line-height confortável; a pontuação faz parte do design.
- **Português SEMPRE com acentos** (ção, é, ê, ã) — remover acento é erro visual grave.

## 3. Superfícies e elementos
- **Corner radius consistente**: cards ~16-22px; ícones internos ~10-14px; botões/badges totalmente arredondados (pill). Elemento interno sempre com raio **menor** que o container.
- Cards são **superfícies de software flutuando** — nunca hardware: sem bezel, sem forma de celular/tablet, sem espessura física, sem botão ou câmera.
- **Máx. 3 itens** dentro de qualquer card (label, valor hero, um detalhe/gráfico).

## 4. Qualidade e luz
- **Qualidade de render CGI fotorrealista**, tipo slide de keynote da Apple — NÃO design gráfico flat, NÃO template Canva.
- Sombras suaves e difusas (raio grande, opacidade baixa), profundidade sutil entre camadas, materiais que reagem à luz.
- **Um sistema de cor coeso** na imagem inteira; **no máximo UMA cor de acento**. Sem cores aleatórias extras.

## 5. Proibições
- **NÃO imaginar/inventar NADA que não foi pedido**: sem logo inventada, marca, selo, badge, texto extra, label, número ou decoração além da copy pedida e das referências.
- Quando **nenhuma logo foi anexada**, uma regra extra é injetada: "este design NÃO tem logo — não desenhe nenhuma logo, monograma ou ícone de marca".
- Sem marca d'água, sem UI de app, sem poluição, sem fogo/neon sem propósito, sem texto centralizado de borda a borda.

---

*Pra ajustar qualquer regra: editar `backend/src/flow/designSpec.ts` (o hash de cache muda — os designs serão regerados na próxima geração).*
