# DESIGN RULES — MotionIA
> Análise visual de cada referência + regras obrigatórias para geração de prompts.
> Atualizado com análise real de todas as imagens (agora em .jpeg).

---

## ÍNDICE
1. [Análise por Imagem](#análise-por-imagem)
2. [Padrões Recorrentes](#padrões-recorrentes)
3. [REGRAS OBRIGATÓRIAS](#regras-obrigatórias)
4. [Template de Prompt](#template-de-prompt)
5. [Erros das Gerações Anteriores](#erros-das-gerações-anteriores)

---

# ANÁLISE POR IMAGEM

---

## REF-01 · `7eec4123-648e-4f4a-8c0c-9004674cea5c.png`
**STATUS: REFERÊNCIA MÁXIMA. Qualidade mínima aceitável para qualquer geração.**

### Composição geral
Formato 9:16 vertical. Texto no canto superior-esquerdo, elementos 3D em cluster diagonal fluindo do centro para a direita/cima. Megafone solitário no canto inferior-esquerdo. Apple logo pequeno no topo centrado. Muito espaço negativo — a imagem respira.

### Background
- Gradiente radial prata/perolado. Centro ~#f0f0f4 (branco-frio), bordas ~#b8b8bc (cinza-prata)
- Sem textura, grain ou ruído. Completamente liso
- Leve vinheta escurecendo as bordas — não é branco puro, é prata luminoso
- A superfície reflete levemente os elementos 3D (reflexo de estúdio no piso)

### Tipografia
- Fonte: SF Pro Display ou Helvetica Neue Ultra Light — geométrica, zero serifa, zero ornamento
- **Sistema de dois pesos — obrigatório:**
  - Nível 1 (build-up): Regular/Light, ~#888 a #999, corpo médio, line-height apertado
    - "A maioria das lojas / que investe / em anúncio / vive o"
  - Nível 2 (punch): Heavy/Black, ~#111, 2.2x a 2.5x maior, tracking tight
    - "mesmo / caos."
- Alinhamento: esquerdo, partindo da margem esquerda com ~6% de padding
- Largura: ocupa no máximo 62% do frame — nunca toca a borda direita
- Sem qualquer box, container, sombra ou sublinhado — letra solta no fundo
- A palavra "caos." tem ponto final — pontuação é parte do design
- A transição de peso entre os níveis é o evento visual central da peça

### Elementos 3D
- **Chrome fragments:** 6-8 cacos metálicos ultra-reflexivos, prata/cromo, pequenos (~3-7% da largura do frame). Espalhados em diagonal. Capturam o ambiente e criam reflexos especulares brancos e cinzas. Sem cor
- **UI Cards (dashboard cards):** 3-4 cards escuros (#1a1a1a a #222) flutuando em perspectiva leve (5-10° de rotação). Conteúdo: gráficos de linha vermelhos com quedas, métricas (ROI -78%, 1.02%, valores em BRL), ícone de cifrão. Cards têm corner radius ~14-16px
- **Megafone 3D:** canto inferior-esquerdo, objeto prata/chrome, escala pequena, não é o foco — é elemento narrativo
- **Apple logo:** pequeno, cinza médio, centrado no topo — NÃO USAR em nossas peças (usuário rejeitou)
- Fluxo: espiral diagonal do inferior-esquerdo ao superior-direito

### Cores
- 100% monocromático: preto, branco, prata, cinza, chrome
- Zero hue, zero saturação. Nenhum elemento colorido exceto os gráficos vermelhos DENTRO dos cards (e mesmo esses são discretos)
- A cor "vermelha" dos gráficos dentro dos cards é intencional — representa queda/caos

### Efeitos
- Sombras ultra-suaves nos cards (sombra difusa, grande raio, opacidade ~15%)
- Reflexo de ambient light no chão (prata refletido)
- Profundidade: elementos em diferentes planos Z criam ilusão de 3D
- Qualidade CGI de produto Apple — não é design gráfico, é render fotorrealista

### Espaçamento
- Top padding: ~8% antes do texto começar
- Left padding: ~6% antes do texto
- Zona de respiro entre o texto e os elementos 3D: ~15% do frame
- Bottom 20%: megafone + espaço limpo

### O QUE ESTA IMAGEM ENSINA
1. Prata + preto é uma paleta completa — sem precisar de cor
2. O contraste de peso tipográfico substitui qualquer decoração
3. Chrome fragments adicionam riqueza sem poluição visual
4. CGI fotorrealista eleva qualquer composição

---

## REF-02 · `57e28c30-8577-480d-80d1-5110e88bfa41.png`
**STATUS: Referência de composição clean + acento de cor único**

### Composição geral
9:16 vertical. Terço superior: número + texto. Terço médio + inferior: gráfico 3D dominante. Badge pill na base. Muito espaço negativo entre elementos.

### Background
- Branco puro / branco-frio levíssimo (~#f8f9ff). Quase flat
- Sem gradiente perceptível

### Tipografia
- "1" — azul puro (#0066FF a #0055EE), peso Black, ~30% da largura do frame, canto superior-esquerdo
- Corpo: Regular/Light, preto (#111), left-aligned, tamanho pequeno-médio
- "não mudar" — mesmo peso que o corpo mas azul (#0066FF) — acento pontual de cor em palavra-chave
- Estrutura: o "1" é o número do slide/tópico, o texto é o conteúdo

### Elemento 3D
- Gráfico de barras 3D branco/off-white — ocupa ~65% do frame
- Barras com perspectiva lateral, queda gradual da esquerda para direita
- Seta azul grande apontando diagonalmente para baixo
- Qualidade render limpa, sombras suaves brancas

### Badge/Pill
- Forma: pill largo, branco, fundo levemente cinza/sombra
- Conteúdo: ícone de seta ↓ (azul) + "1.000.000,00 vendas" (preto)
- Border radius: completamente arredondado (50% de raio)
- Posição: zona inferior, centralizado

### Cores
- Branco + Azul (#0066FF) como único acento
- Preto para texto principal
- Branco/off-white para elementos 3D

### O QUE ESTA IMAGEM ENSINA
1. UM número/cor de acento é suficiente — o resto em neutro
2. O badge pill é um componente UI recorrente e elegante
3. Gráfico 3D como elemento focal funciona muito bem
4. Composição: texto no topo → visual no centro → badge na base

---

## REF-03 · `Chats • Instagram.jpeg`
**STATUS: Referência de glassmorphism dark + progress UI**

### Composição geral
Formato quadrado ou levemente vertical. Fundo escuro total. Card de glassmorphism centralizado ocupando ~70% do frame. Labels informativos no topo e inferior (pill tags).

### Background
- Azul-marinho escuro profundo (#0a0f1e a #060b16). Quase preto mas com temperatura azul
- Gradiente sutil — mais escuro nos cantos, levemente azulado no centro
- Duas "colunas" de glow azul elétrico no terço inferior — como projetores de luz vindo de baixo

### Card Principal (glassmorphism dark)
- Fill: azul muito escuro transparente (~rgba(10,20,60,0.7))
- Background blur: visível e intenso — conteúdo atrás fica completamente embaçado
- Border: 1px rgba(255,255,255,0.12) — quase invisível
- Corner radius: ~20-24px (cantos generosamente arredondados)
- Sombra: nenhuma sombra dura — o card flutua porque o fundo escuro cria contexto
- Sem padding excessivo — conteúdo ocupa quase toda a área

### Conteúdo do card
- Ícone 3D de arquivo TXT (blue 3D folder icon) — isométrico, azul vibrante
- Label: "Project Brief.txt" — SF Pro Display Medium, branco, ~18-20px
- Subtexto: "97.23 KB" — Regular, cinza claro (~#8890a0), ~14px
- Progress bar: track cinza escuro (#1a2040), fill gradiente azul (#3060ff → #60a0ff)
- Text overlay na progress bar: "Uploading ... 73%" — contraste branco sobre azul

### Efeito Glow (crucial)
- Brilho azul elétrico vindo de baixo do card — como se o card emitisse luz
- Glow difuso, grande raio, saturação alta (#3060ff), opacidade ~40-60%
- O glow não tem bordas definidas — vaza pelo frame todo na zona inferior

### Pills informativos
- "Daily Design Challenge" — pill com ícone calendário, fundo #1a2040, texto branco, corner radius 50%
- "Third Part: Day 17-23" — pill igual, canto superior-direito
- "Day 17/23" e "Let's Swipe >" — pills menores, canto inferior
- Todos os pills: padding 8px 16px, corner radius ~20px, fundo semi-transparente escuro

### Tipografia interna
- SF Pro Display / Sistema
- Branco para labels principais
- Cinza (#8890a0) para sublabels e informações secundárias

### O QUE ESTA IMAGEM ENSINA
1. Glow vindo de baixo do card é efeito poderoso e específico
2. Pills informativos nos cantos organizam contexto sem poluir
3. Dark glass funciona melhor com background azul-marinho, não preto puro
4. Ícone 3D dentro do card como elemento hero do conteúdo

---

## REF-04 · `Charging widget.jpeg`
**STATUS: Referência de glassmorphism dark + progress bar com glow interno**

### Composição geral
Formato quadrado, card centralizado em fundo escuro. Simples, direto, maximalista no efeito, minimalista no conteúdo.

### Background
- Azul-marinho escuro (#060b1a). Quase idêntico ao Chats Instagram
- Gradiente suavíssimo do centro para as bordas

### Card (glassmorphism)
- Fill: azul escuro semi-transparente (~rgba(15,30,80,0.6))
- Border: 1px muito sutil, quase invisível
- Corner radius: ~18-22px
- Sombra: difusa azul — não sombra neutra, sombra colorida (blue glow shadow)

### Conteúdo
- "⚡ Charging..." — ícone + texto, cinza/branco, Regular, esquerdo, padding 16px
- "75% • 22 min left" — Bold/Semibold, branco, ~24px
- Progress bar: barra longa, fill branco (~85% preenchido), a parte preenchida é WHITE GLOWING (não apenas branca — ela brilha)
- Texto "75%" dentro da barra, no espaço não preenchido, azul
- Escala do eixo: "0  50  100" — regular, cinza, abaixo da barra

### Efeito Glow da Progress Bar (muito específico)
- A parte preenchida da barra é branca E emite glow azul intenso ao redor
- Parece uma barra de luz — o glow se expande para fora da barra em ~20-30px
- Glow cor: #4080ff a #80c0ff
- Essa técnica transforma uma barra comum num elemento visual premium

### O QUE ESTA IMAGEM ENSINA
1. Glow interno em elementos de progresso eleva a qualidade imediatamente
2. Paleta monocromática azul funciona como um sistema coeso
3. Progress bars com glow são motion-ready (o progresso pode animar)
4. Conteúdo mínimo dentro do card = leitura instantânea

---

## REF-05 · `S-02 · Referral - How it works by Angelive Hilsunny _ Layers.jpeg`
**STATUS: Referência de cards dark glass empilhados com light sweep**

### Composição geral
Formato vertical. Fundo preto puro. 3 cards escuros empilhados verticalmente com espaçamento generoso entre eles. Label de navegação no topo (esquerda e direita). Crédito no rodapé.

### Background
- Preto puro (#000 a #050510). Fundo mínimo — o conteúdo é tudo
- Linha de luz vertical fina no centro — como um fio de luz vindo do topo para trás dos cards

### Cards (dark glass — o PADRÃO)
Cada card tem:
- Fill: gradiente escuro (#1a1a2e → #0f0f20) com leve toalidade roxa/azul
- Light sweep DIAGONAL: faixa luminosa branca/azulada cruzando do canto superior-esquerdo para centro-direito, opacidade ~25-35%, blur leve. Esta é a feature mais importante do card
- Corner radius: 16-20px
- Padding interno: 20-24px todos os lados
- Border: 1px rgba(255,255,255,0.08) — quaaaaase invisível, sutil demais para notar conscientemente mas presente
- Sombra: nenhuma hard shadow — o card flutua no preto

### Conteúdo de cada card
- **Card 1 (Grab your link):** Título Bold branco + subtexto Regular cinza ~#8888aa + ícone pill no canto superior-direito (roxo, corner 12px)
- **Card 2 (Share everywhere):** Maior/mais proeminente — mesmo sistema
- **Card 3 (Stake, & grow together):** Mesmo sistema
- Hierarquia tipográfica: título ~18-20px Bold branco → subtexto ~13-14px Regular cinza
- Ícone: quadrado pequeno (~40x40px) com corner radius ~12px, fundo roxo (#5533ff), ícone branco dentro

### Light Sweep (o efeito mais importante desta imagem)
- Uma faixa diagonal de luz especular cruzando cada card
- Direção: superior-esquerdo → inferior-direito, ~30-40° de inclinação
- A faixa tem: borda superior nítida que vai ficando transparente em direção inferior
- Largura: ~20-25% da largura do card
- Parece a reflexão de uma janela num cartão de crédito ou superfície de vidro
- É o que faz o card parecer "material" e não flat

### Espaçamento entre cards
- Espaçamento vertical entre cards: ~24-32px (respiração clara)
- Cards não se tocam nem se sobrepõem — são elementos separados e independentes

### O QUE ESTA IMAGEM ENSINA
1. **Light sweep diagonal é obrigatório em todo dark glass card**
2. Preto como fundo funciona melhor que dark navy quando os cards têm glow
3. Empilhamento vertical com espaçamento = composição motion-ready (cada card pode entrar animado)
4. Ícone pill no canto superior-direito é padrão de UI premium recorrente

---

## REF-06 · `(2) Home _ X.jpeg`
**STATUS: Referência de analytics card dark com light sweep de canto**

### Composição
Card quadrado centralizado em fundo quase-preto com temperatura azul.

### Card
- Fill: dark semi-transparente, azul-escuro
- **Light sweep de canto:** diferente dos outros — aqui o sweep vem do CANTO SUPERIOR-DIREITO, como um cone de luz penetrando diagonalmente. É mais intenso que um sweep suave — parece um farol apontando para o canto
- Corner radius: ~20-22px (squircle-ish)
- Conteúdo: label "SALES" em caps pequeno, valor "$63,921" grande Bold branco, "+$8,934 (+2,65%)" em verde pequeno, gráfico de linha animável

### Gráfico
- Linha branca com fill area azul semi-transparente embaixo
- Tooltip circular pequeno no pico do gráfico: "$53,210" em pill branco
- Eixo X: meses, cinza escuro
- O gráfico tem "glow" na linha principal — linha branca com halo azul suave

### O QUE ESTA IMAGEM ENSINA
1. Light sweep de canto (cone de luz) como variação do diagonal sweep
2. Gráficos animáveis (a linha pode crescer como motion)
3. Paleta: SALES label → valor grande → variação verde/cinza = hierarquia de 3 níveis dentro de um card

---

## REF-07 · `(1) Home _ X (1).jpeg`
**STATUS: Referência de card dark com notificações coloridas (glassmorphism)**

### Composição
Card horizontal escuro em fundo cinza escuro. Conteúdo: título + 2 notificações pill coloridas + dots de navegação.

### Card
- Fill: #1a1a1a sólido escuro
- Corner radius generoso (~20-24px)
- Fundo atrás do card: cinza (#3a3a3a) com gradiente escuro nas laterais — cria senso de ambiente

### Notificações internas (os pills coloridos)
- **Pill vermelho (Road Work):** fill red/orange gradiente, corner radius ~14px, ícone X branco, texto branco bold + Regular
- **Pill verde (Traffic Jam):** fill green (#2ebb7a), corner radius ~14px, ícone info branco, texto branco
- Os pills são GLASSMORPHISM: não são sólidos, têm leve transparência com material de vidro

### O QUE ESTA IMAGEM ENSINA
1. Cores dentro de cards escuros funcionam SE os elementos coloridos têm o mesmo material (glass/semi-transparent)
2. Corner radius dos pills internos deve ser menor que o do card externo (14 vs 20-24)
3. Notificação/status card é um padrão útil para mostrar impacto/resultados

---

## REF-08 · `ClauseOS Dashboard – Compliance Management Platform.jpeg`
**STATUS: Referência de deck de cards em perspectiva 3D — composição de profundidade**

### Composição
Fundo preto. Cards em perspectiva, como um baralho visto de cima e levemente de lado. Um card verde em destaque (o ativo), os outros cinza/transparente. Um card popup de detalhe flutua na frente de tudo.

### Os cards do deck
- Cards de fundo: material translúcido claro (frosted glass, quase branco com 20% opacidade)
- Corner radius: ~16-18px
- Inclinados ~20° para criar perspectiva de profundidade
- Conteúdo: ícone de pessoas, texto de categoria ("Compliance", "Training", etc.), número
- **Card verde (ativo):** sólido green (#2ebb7a), corner radius igual, emite glow verde suave ao redor

### Card de detalhe (popup flutuante)
- Fill: branco sólido + muito leve blur background
- Corner radius: ~16px
- Sombra: soft, grande raio, preto ~20%
- Conteúdo: "Corporate / Jan 01 – Mar 31", "87%", seta de navegação
- Um ponto de glow verde no interior referencia o card ativo abaixo

### O QUE ESTA IMAGEM ENSINA
1. Deck de cards em perspectiva = composição motion-ready (cada card pode entrar/sair animado)
2. Um card colorido num deck neutro cria hierarquia visual imediata
3. Card de detalhe flutuando ACIMA do deck é popup clássico e funciona bem
4. Mistura de glass claro + sólido escuro no mesmo contexto: funciona quando é sistemático

---

## REF-09 · `popup UI.jpeg`
**STATUS: Referência de popup card com neumorphism + elemento badge externo**

### Composição
Fundo cinza muito claro (#e8e8ea). Card branco centralizado. Ícone badge saindo do topo do card (breaking the box). Botão preto na base do card.

### Background
- Cinza claro suave, levíssimo gradiente radial de branco no centro para cinza nas bordas
- Tom: #e5e5e8 a #ececef — quase branco mas claramente cinza

### Card principal
- Fill: branco puro (#ffffff)
- Corner radius: **muito grande — ~28-32px (squircle-ish)**. É um dos cantos mais arredondados das referências
- Sombra: suave, múltiplas camadas, criando profundidade neumórfica
  - Sombra principal: rgba(0,0,0,0.08), raio 20px, offset Y 8px
  - Highlight superior: rgba(255,255,255,0.9) offset Y -4px — cria o efeito neumórfico
- Padding interno: ~24px todos os lados

### Badge externo (breaking the box)
- Ícone escudo verde 3D saindo da borda superior do card (~50% acima, 50% dentro)
- Isso cria uma composição interessante: o elemento "transborda" o container
- Corner radius do badge: ~10-12px, forma de escudo/folha, não quadrado

### Conteúdo
- "3-Day Streak Achieved" — Bold preto, ~20px, centrado
- "Staying consistent and keep it up" — Regular cinza, ~14px, centrado
- Indicadores de dias (S M T W T F): ícones de raio em círculo verde para os ativos, cinza para os pendentes. Corner radius dos círculos: ~50% (redondos perfeitos)
- O ativo central (T) tem glow verde suave ao redor

### Botão
- Fill: preto sólido (#0d0d0d)
- Corner radius: ~50% (pill shape — completamente arredondado)
- Texto: "collect" — Regular branco, ~16px, centrado
- Largura: ~75% do card, não vai de borda a borda

### O QUE ESTA IMAGEM ENSINA
1. **Squircle corner radius (~28-32px) em cards brancos = aspecto premium**
2. Badge/elemento saindo do topo do card (breaking the box) é técnica de composição que chama atenção
3. Botão pill preto em card branco = contraste máximo, sempre funciona
4. Ícones em círculos com estado ativo/inativo criam sequência temporal — motion-ready

---

## REF-10 · `soft system ui _ design layers.jpeg` & `dynamic ui stack _ motion layout.jpeg`
**STATUS: Referência de lista empilhada com hierarquia por profundidade**

### Composição
Fundo cinza cálido (#e8e6e0 — bege-cinza suave). Lista vertical de pills centralizados. Em "soft system ui": visão frontal. Em "dynamic ui stack": mesma lista em perspectiva 3D (inclinada ~15-20°), mostrando o sistema como deck animável.

### Background
- Bege-cinza quente (#e8e6df) — NÃO é cinza frio. É quase branco com toque de creme/areia
- Zero gradiente — flat e quente

### Pills da lista
- Fill: branco (#ffffff) ou off-white muito leve
- Corner radius: **completamente arredondado (50% = pill shape perfeito)**
- Largura: cada pill tem tamanho diferente — o item ATIVO/FOCAL é o mais largo e mais escuro (mais Bold)
- Sombra: soft shadow dupla (neumorphism): sombra escura suave + highlight claro superior
- Conteúdo: ícone quadrado com corner radius ~10px (cada um com cor diferente: rosa, azul, laranja, roxo, amarelo, vermelho, verde) + texto label

### Hierarquia de profundidade (o conceito central)
- Item no topo: menor, mais transparente/apagado (menor peso visual)
- Item ativo (centro): maior, mais bold, mais visível, mais escuro
- Itens de baixo: voltam a ser menores e mais claros
- Essa hierarquia simula perspectiva — o item ativo "vem para frente"
- Em "dynamic ui stack": a lista está inclinada e cada item parece um card num deck 3D

### Espaçamento entre pills
- ~12-16px de gap entre cada pill
- Os pills têm padding interno: ~12px vertical, ~16px horizontal

### O QUE ESTA IMAGEM ENSINA
1. **Lista de pills = estrutura motion-ready perfeita** — cada pill pode entrar/sair/animar individualmente
2. A versão perspectiva mostra exatamente como uma lista flat pode virar um deck 3D em motion
3. Ícones coloridos + fundo neutro = sistema coeso (as cores são dos ícones, não do fundo)
4. Profundidade por escala/opacidade substitui sombras complexas

---

## REF-11 · `Steps AI design_ Encourage movement with subtle animations.jpeg`
**STATUS: Referência de cards de steps conectados por linha pontilhada + bottom bar**

### Composição
9:16 vertical. Fundo gradiente morno (azul-cinza claro no topo, pêssego/salmão claro no lado direito). Três cards de steps conectados por linha pontilhada vertical. Bottom sheet no rodapé.

### Background
- Gradiente 3 cores: azul-cinza frio (#d0d8e8) superior-esquerdo → branco/neutro → salmão/pêssego (#e8c8c0) inferior-direito
- Leve e harmonioso — tons pastel dessaturados

### Cards de Steps
- **Step 1 (Warm-up) — concluído:** glass claro, fill branca/levemente esverdeada, corner radius ~20px, ícone ✓, sol emoji, glow verde suavíssimo ao redor
- **Step 2 (Stretch) — ativo:** fill azul vibrante (#3080ff), corner radius ~20px, ícone ✓, personagem ioga, texto branco
- **Step 3 (Balance/Cool-down) — bloqueado:** fill cinza (#cccccc), corner radius ~20px, número "3", ícone apagado, texto cinza escuro
- Os três cards têm o mesmo tamanho e alinhados centralmente

### Linha conectora
- Linha pontilhada vertical fina connecting os cards
- Bolinhas brancas nos pontos de conexão (onde a linha toca os cards)
- Estilo: dashed com dots espaçados

### Bottom Sheet
- Fill: branco puro, corner radius superior ~20px (flat nos corners inferiores)
- Contém: seletor de sessão (pills horizontais: "Balance" ativo + "Cool-down" inativo), botão azul pill "Start", texto "Time left: 15:00"
- **Seletor:** pill ativo = fundo branco sólido (elevado dentro do container cinza); pill inativo = cinza sem preenchimento
- **Botão Start:** azul gradiente (#3080ff → #60b0ff), corner radius ~50%, largura ~70% do sheet

### O QUE ESTA IMAGEM ENSINA
1. Linha pontilhada vertical como conector entre elementos = motion-ready (pode animar percorrendo a linha)
2. 3 states de card (ativo/concluído/bloqueado) com paleta consistente mas fill diferente
3. Bottom sheet como elemento de ação separado do conteúdo principal
4. Gradiente pastel de fundo = alternativa ao branco puro quando quer mais calor

---

## REF-12 · `Mac Bro _ Social Media Design _ Reels Cover.jpeg`
**STATUS: Referência de reel cover dark com app icons 3D + glow burst**

### Composição
9:16 vertical. Dark navy. Dois ícones de app 3D sobrepostos no centro, com burst de luz azul por trás. Texto tipográfico na metade inferior.

### Background
- Dark navy (#050a1a) com gradiente radial azul centrado onde estão os ícones
- O glow por trás dos ícones: #0040ff a #0060ff, grande radius, alta intensidade

### Ícones 3D
- **Ícone escuro:** fundo #0a0a14 com padrão de pontos brancos circulares, corner radius ~22-24px (squircle)
- **Ícone azul (MacBro):** gradiente azul intenso #0050ff → #0080ff, logo "MacBro" branco, corner radius idêntico ~22-24px
- Os dois ícones sobrepõem-se em ~30%, posicionados em diagonal (esquerdo-frente, direito-atrás)
- Ícone azul tem borda reflexiva prata/branca simulando espessura física
- Símbolo "×" (interseção) entre os dois ícones: círculo pequeno azul com "X" branco

### Glow Burst
- Luz radial saindo do ponto de interseção dos ícones
- Cruzes de luz (light rays/lens flares) em 4 direções — como raios de sol estilizados

### Tipografia inferior
- "MacBro" — azul claro (#4488ff), Regular/Light, topo da área de texto, centrado
- "Iman × MacBro" — branco, Extra-Bold, muito grande, left-alinhado com padding
- "→ Halol" — com seta, branco Bold
- "muddatli to'lov" — itálico branco

### O QUE ESTA IMAGEM ENSINA
1. Dois objetos 3D sobrepostos com glow burst entre eles = composição dinâmica
2. App icons 3D com squircle radius são o "objeto" equivalente ao que o usuário quer como UI focal
3. Dark navy como fundo intensifica qualquer glow azul
4. Texto em duas zonas (label pequeno topo + hierarquia Bold embaixo) = estrutura de reel cover

---

## REF-13 · `Social Media Post.jpeg`
**STATUS: Referência de glassmorphism cards flutuando em fundo sólido**

### Composição
Quadrado. Fundo azul sólido vibrante (#1155ee). 3 cards glass flutuando em posição angular. Card central dominante (maior, ereto), cards laterais menores e inclinados.

### Background
- Azul sólido (#1155ee a #0044cc) — sem gradiente complexo, é quase flat com leve escurecimento nas bordas
- Grid de linhas finas cinza/brancas (~opacity 10%) como pattern de fundo

### Cards Glassmorphism
- Fill: branco ~15-20% de opacidade
- Background blur visível
- Border: 1px branca ~30% opacidade
- Corner radius: ~16-18px
- **Card central (hero):** fundo branco mais sólido, escala maior, posição ereta. Fill: branco 80%+ (quase sólido). Ícone preto grande centralizado no card
- **Cards laterais:** mais transparentes, levemente inclinados, menores

### O QUE ESTA IMAGEM ENSINA
1. 3 cards em arranjo frontal+lateral com hierarquia por tamanho e opacidade
2. Fundo colorido sólido funciona com glassmorphism se os cards são da mesma temperatura de cor
3. Card central maior + sólido = hero; cards laterais menores + transparentes = suporte

---

## REF-14 · `popup UI.jpeg` (Streak popup)
*[Analisado em REF-09 acima]*

---

## REF-15 · `Landing Page Design Tips for High Conversions.jpeg`
**STATUS: Referência de seletor neumórfico com estado ativo colorido**

### Composição
Horizontal/paisagem. Fundo cinza muito claro/branco (#f0f0f2). 5 elementos pill alinhados horizontalmente. Indicador triangular acima do ativo.

### Elementos pill
- Fill: branco (#ffffff), corner radius ~50% mas não circular (pill ovalo vertical)
- Sombra neumórfica: shadow escura suave embaixo-direita + highlight branca no topo-esquerda
- Conteúdo: letra do dia acima + número grande dentro

### Estado ativo
- Círculo vermelho (#dd3333) preenchendo o topo do pill ativo
- Muito impactante — o único elemento de cor no campo de neutralidade
- O número dentro do ativo é branco (inverte o contraste)
- Triangulo pequeno preto acima apontando para o ativo

### O QUE ESTA IMAGEM ENSINA
1. Estado ativo com cor de acento em campo neutro = hierarquia óbvia sem explicação
2. Neumorfismo (light bg + dupla sombra) cria profundidade sutil e premium
3. Indicador externo (triângulo) reforça seleção — pode animar deslizando

---

## REF-16 · `Daybase App Icon.jpeg`
**STATUS: Referência de produto dark + SF Pro Display puro**

### Composição
9:16 vertical. Fundo preto puro. Terço superior: tipografia branca. Terço inferior: iPhone 15 Pro em extreme close-up (corner inferior-esquerdo do dispositivo).

### Tipografia
- "Try the Lifetime Free / basic version" — Regular/Light, branco #ccc, centrado, pequeno
- "Daybase.app" — Extra-Bold, branco puro (#fff), grande. Esta é a tipografia do estilo que o usuário quer
- Botão "Download on the App Store" — outline pill (borda branca, fill transparente), ícone Apple, texto Regular

### O dispositivo
- iPhone 15 Pro Titanium — corner do dispositivo visível no canto inferior-esquerdo
- Tela mostrando app icon do Daybase + horário 9:41
- A qualidade de render é fotorrealista — brilho da tela, reflexo do aro, etc.

### O QUE ESTA IMAGEM ENSINA
1. Preto puro + branco puro = contraste máximo, leitura instantânea
2. SF Pro Display Extra-Bold em fundo preto é o padrão de produto Apple
3. Close-up de hardware como elemento visual funciona para produtos físicos/apps

---

## REF-17 · `Talvez seja útil_.jpeg`
**STATUS: Referência de composição de rede/mapa mental com fundo neutro**

### Composição
Vertical. Fundo cinza-claro (#ebebed). Rede radial com cérebro 3D no centro, 6 app icons nos vértices, texto grande em baixo.

### Background
- Cinza claro frio (#ebebed), círculo difuso branco/cinza levíssimo centrado (sugere spotlight suave)

### App icons
- Squircle black (#0d0d0d) com ícone branco interno
- Corner radius: ~22-24px
- Linhas de conexão: pretas, finas (~1-1.5px), curvadas levemente
- Posicionados nos vértices de um hexágono imaginário

### Cérebro 3D
- Cérebro rosa/nude 3D, realista, escala pequena (~8% do frame), centralizado
- Sobre círculo de halo difuso

### Tipografia
- "EXTENSÕES PARA" — Regular caps, #1a1a1a, centrado, corpo pequeno
- "O SEU CÉREBRO" — Ultra-Black bold, #0d0d0d, muito grande, centrado
- Estilo: hierarquia de peso similar à REF-01 (pequeno → grande Bold)
- "REINVENT YOURSELF" — spaced caps, cinza, rodapé
- Emoji 👉 como ponteiro — elemento informal mas funciona

### O QUE ESTA IMAGEM ENSINA
1. Rede/mapa radial com objeto 3D central funciona como elemento focal sem UI
2. App icons squircle pretos são mais premium que coloridos neste contexto
3. A hierarquia tipográfica da REF-01 funciona mesmo em fundo claro sem 3D complexo

---

## REF-18 · `Ahtasham (@Ahtasham_Design) on X.jpeg`
**STATUS: Referência de UI dark minimalista — input field premium**

### Composição
Recorte horizontal de um app dark mode. Fundo escuro (#111). Um input field centralizado com orbe metálica dourada à esquerda.

### Input field
- Fill: muito escuro, levíssimo gray (#1a1a1a)
- Corner radius: **0 — o campo tem cantos retos** — diferente das outras referências. O borda é a borda do app
- Texto placeholder: "Let's do some magic..." — Regular/Light, cinza médio (~#666), italic feeling
- Cursor: linha vertical branca
- Separador vertical entre orbe e texto: 1px cinza (#333)

### Orbe metálica
- Esfera dourada/bronze 3D ultra-realista — reflexos de ambiente, highlight branco, shadow gradual
- Diameter: ~32-36px
- Parece gold/bronze polido — material premium

### Bottom toolbar
- Avatar circular: foto real com tratamento fotográfico
- Ícones: clipe (attachment), globo (Advanced Search) em pill escuro
- "Advanced Search" pill: fundo #2a2a2a, corner radius ~50%, texto branco Regular, ícone globo azul

### O QUE ESTA IMAGEM ENSINA
1. Orbe/esfera 3D metálica como elemento UI (cursor/avatar substituto)
2. Dark mode com elementos quentes (gold) vs fundo frio (dark gray) = temperatura interessante
3. Toolbar bottom com pills escuros de ação

---

## REF-19 · `X🔥.jpeg` (envelope Superpower)
**STATUS: Referência de hero illustration dark + glow interno**

### Composição
Quadrado. Fundo preto puro. Envelope 3D escuro/preto ao centro, aberto, revelando carta laranja/vermelha brilhante dentro.

### Envelope
- Material: preto fosco, textura suave
- Corner radius: ~8-10px (corners mais suaves que um envelope real)
- A abertura do envelope revela glow interno

### Carta/Glow interno
- Fill: gradiente laranja vibrante (#cc3300 → #ff6600 → #ffaa00) com radial glow
- Texto na carta: branco
- O glow vazando pelo topo do envelope ilumina a cena inteira — a luz laranja colore o próprio envelope

### O QUE ESTA IMAGEM ENSINA
1. Objeto 3D + glow interno colorido saindo dele = composição cinematográfica poderosa
2. Preto absorve tudo e faz qualquer glow parecer mais intenso
3. A "luz de dentro" é uma técnica de motion: o glow pode pulsar ou crescer

---

## REF-20 · `download (10).jpeg` (3 List Principles)
**STATUS: Referência de conteúdo motion/vídeo — não é um design de UI**

Fundo roxo/purple (#330066 → #550099). Texto grande no topo "3 LIST PRINCIPLES" em sans-serif bold branco com brilho/glow. Cards numerados conectados em vertical. Estilo mais YouTube/TikTok thumbnail do que design premium.

### O QUE ESTA IMAGEM ENSINA (por contraste — o que NÃO FAZER)
- ❌ Glow no texto parece datado
- ❌ Fundo roxo saturado sem modulação parece agressivo
- ❌ Cards com corner radius irregular (mix de reto e arredondado) parecem inconsistentes

---

## REF-21 · `download (12).jpeg` (Analytics cards light design system)
**STATUS: Referência de cards minimalistas dark com gráficos de dados**

### Composição
Fundo preto puro. Dois cards escuros empilhados verticalmente, centralizados horizontalmente (não ocupam o frame todo — 60% da largura).

### Cards
- Fill: #1a1a1e (quase preto, um step acima do fundo)
- Corner radius: ~12-14px
- Border: 1px #2a2a2e (subtilíssima, só para definir o edge)
- Sem sombra — o card define-se por ser levemente mais claro que o fundo
- **Conteúdo (card 1):** label "Impressions" gray, valor "117K" Bold branco, "+10%" verde pequeno, gráfico de linha branca
- **Conteúdo (card 2):** mesma estrutura, "Engagements 12.8K -5%" vermelho

### Tooltip do gráfico
- Pill branco pequeno com "Dec 6 / 12,947 / Impressions" — aparece sobre o ponto ativo do gráfico
- Corner radius: ~6-8px, preenchimento branco, texto preto

### O QUE ESTA IMAGEM ENSINA
1. Border 1px #2a2a2e em fundo preto: suficiente para definir o card sem shadow
2. Estrutura de card de analytics: label cinza → valor grande branco → variação verde/vermelho
3. Gráfico com tooltip = motion-ready (a linha pode crescer, o tooltip pode aparecer animado)

---

## REF-22 · `download (14).jpeg` (Notification cards coloridos em fundo dark)
**STATUS: REFERÊNCIA DO QUE NÃO FAZER — cores em abundância**

4 cards empilhados: vermelho, verde, azul, escuro. Cada um com cor diferente. Fundo preto.

### O QUE ESTA IMAGEM ENSINA (por contraste — NÃO USAR):
- ❌ 4 cores diferentes em 4 cards = sistema de cores sem coerência
- ❌ Verde choque ao lado de vermelho saturado = conflito visual imediato
- ❌ Cada card parece de um sistema diferente

---

## REF-23 · `download (17).jpeg` (Branding radar chart)
**STATUS: Referência de infográfico minimalista + acento laranja**

Fundo branco puro. Radar/hexagon chart com linhas cinza-claras. Centro: círculo com glow laranja suave + texto "Branding" em laranja. Texto cinza nas extremidades.

### O QUE ESTA IMAGEM ENSINA
1. Diagrama geométrico (radar/hexagon) como elemento focal funciona muito bem
2. Glow/halo suave ao redor do ponto focal = spotlight técnica
3. Um acento laranja em campo cinza é suficiente para hierarquia completa

---

## REF-24 · `download (18).jpeg` (Pie chart glassmorphism)
**STATUS: Referência de gráfico com glow interno + glassmorphism**

Fundo cinza-frio levíssimo. Pie chart 3D/glassmorphism: segmento maior (70%) preenchido com glow azul-violeta intenso no interior, segmento menor (30%) cinza-claro com reflexo especular. Linhas de legenda finas saindo dos segmentos para labels laterais.

### Efeito do glow interno no pie
- O segmento azul tem um glow radial no interior — parece iluminado por dentro
- A cor não é só azul — tem bloom/glow roxo ao redor (#5533ff com bloom expandindo)
- O segmento cinza é vidro fosco claro por contraste

### O QUE ESTA IMAGEM ENSINA
1. Glow interno em elementos de dados (bloom) cria dimensão imediata
2. Segmento ativo + glow = motion-ready (o glow pode pulsar)
3. Glassmorphism em pie chart: segmento principal sólido+glow, segmento secundário glass

---

## REF-25 · `download (20).jpeg` (YOUNGEM — black bg produto)
**STATUS: Referência de composição editorial dark + tipografia SF + objetos 3D neutros**

Fundo preto com leve gradiente warm no centro. Duas mãos 3D neutras (cor de borracha/latex, estilizadas) fazendo gesture de toque — uma apontando de cima, outra segurando dispositivo embaixo. Esfera branca minúscula no centro (ponto de luz). Tipografia branca em múltiplas zonas.

### Tipografia
- Topo: regular light, centrado, corpo pequeno — "Neutral and adaptable for any use-case"
- Meio: Bold/Semibold branco "Modern / gestures & / motions" left-aligned (~35%)
- Rodapé: mix de regular, orange accent para frases especiais, logo, URL

### Mãos 3D
- Material: rubber/latex neutro — sem tom de pele humano, sem textura
- Cinza-branco, quase monocromáticas
- Shadow sutil embaixo de cada mão

### O QUE ESTA IMAGEM ENSINA
1. Mãos 3D neutras como elementos de interação/gesture — mais premium que mãos fotográficas
2. Esfera branca minúscula de luz = marcador de ponto de toque, motion-ready
3. Composição em dois planos verticais (mão superior + mão inferior com dispositivo) usa o frame vertical 9:16 perfeitamente

---

## REF-26 · `download (21).jpeg` (Make your move — Blueberry Markets)
**STATUS: Referência de fotografia + tipografia + elementos 3D**

Fundo dark com texture de nuvens/fumaça. Pessoa em terno caminhando sobre blocos 3D iluminados. Tipografia branca enorme ao fundo.

### Tipografia
- "Make / your / move." — Ultra-Bold/Black, branco, ocupa ~70% da largura, left-aligned. Ponto final faz parte
- Escala: as letras são tão grandes que a figura humana caminha "dentro" da tipografia

### Blocos 3D
- Cubos pretos com borda de luz branca/neon ao redor de cada face superior
- A pessoa caminha sobre eles — composição cinema/produto apple

### O QUE ESTA IMAGEM ENSINA
1. Tipografia em escala dramática com figura humana em cima = composição editorial de alto impacto
2. A tipografia grande NÃO é poluição — ela é o elemento visual principal
3. Borda de luz em objetos 3D (rim light de objeto, não só do ambiente) = técnica para dar dimensão

---

## REF-27 · `(1) Home _ X.jpeg` (Analytics dark card com line chart)
*[Analisado em REF-06 acima com mais detalhe]*

---

## REF-28 · `(4) Instagram.jpeg` (Conversion rate 400%)
**STATUS: Referência de analytics card dark com glow azul borda**

Card escuro com gráfico de linha em fundo quase-preto. O elemento mais especial é o **glow na borda inferior do card**: luz azul elétrica vazando da borda inferior do card, como se o card fosse uma fonte de luz. Gráfico de linha branca com pico e fill área azul.

### O QUE ESTA IMAGEM ENSINA
1. **Glow na BORDA do card** — não apenas atrás ou dentro: a borda inferior emite luz azul
2. "Conversion rate 400%" como tipografia de impacto dentro de um card analítico
3. O card pode ser o hero de toda a composição sem precisar de outros elementos

---

---

# PADRÕES RECORRENTES

## Padrão de Cores por Fundo

| Fundo | Sistema de Cor | Exemplos |
|-------|---------------|---------|
| Prata/Pearl | 100% monocromático | REF-01 (7eec4123) |
| Dark Navy | Azul monocromático | REF-03, 04, 06, 08 |
| Preto puro | Monocromático + 1 acento | REF-05, 21, 25, 26 |
| Branco puro | Preto + 1 acento (azul/roxo) | REF-02, 17 |
| Cinza claro | Neumórfico, acento pontual | REF-09, 10, 15 |
| Azul sólido | Glass branco | REF-13 |

## Padrão de Corner Radius

| Tipo de Elemento | Corner Radius |
|-----------------|--------------|
| Card hero (dark glass) | 16-22px |
| Card popup/detalhe | 20-28px |
| Card app icon (squircle) | 22-26px |
| Botão pill | 50% (completamente redondo) |
| Pill label/badge | 50% (completamente redondo) |
| Item de lista pill | 50% (completamente redondo) |
| Ícone dentro de card | 10-14px |
| Tooltip pequeno | 6-8px |

## Padrão de Efeitos Recorrentes

| Efeito | Onde aparece | Como |
|--------|-------------|------|
| **Light sweep diagonal** | Todos os dark glass cards | Faixa ~25% da largura, ~30-40°, opacidade 25-35% |
| **Glow de borda inferior** | Cards analíticos dark | Luz colorida vazando pela borda inferior |
| **Glow radial por trás** | Cards flutuantes, ícones 3D | Bloom grande, cor do tema, opacidade ~40-60% |
| **Glow interno** | Progress bars, pie charts | Fill luminoso que "emite" |
| **Badge breaking-the-box** | Popup cards | Elemento saindo da borda do card |
| **Pill de status** | Todos os sistemas | Corners 50%, conteúdo ícone+texto |

---

---

# REGRAS OBRIGATÓRIAS

> **INEGOCIÁVEIS.** Qualquer violação produz resultado ruim automaticamente.

---

## REGRA 1 — PALETA DE CORES: ESCOLHER UM SISTEMA E SEGUIR SEM EXCEÇÃO

**Antes de qualquer elemento, declarar a paleta. Tudo que vier depois obedece essa paleta.**

### Sistema A — Prata/Monochrome (target principal — REF-01)
- Background: gradiente radial prata-pearl (#f2f2f7 center → #c8c8cc edges)
- Tipografia: níveis 1 cinza (#888-#999) + nível 2 quase-preto (#0d0d0d-#111)
- Elementos 3D: chrome, prata, cinza — zero hue
- Cards/glass: ou frosted white (~15% opacity) ou dark (#1c1c1e)
- SE usar cor: UMA cor de acento só em UMA categoria de elemento
- PROIBIDO: elemento rosa, elemento vermelho de alerta, gradiente colorido de fundo

### Sistema B — Dark Navy/Blue (alternativo)
- Background: #060b1a a #0a0f1e
- Elementos: shades de azul (#3060ff glow) + branco para texto
- Cards: dark glass com border sutil
- PROIBIDO: misturar vermelho/verde/laranja no mesmo frame

### Sistema C — Preto puro + acento
- Background: #000 a #0a0a0a
- Tudo em preto/branco EXCETO UM elemento de acento (azul, laranja, roxo — escolher um)
- PROIBIDO: mais de uma cor de acento

**REGRA DE OURO:** Se você vê um elemento e pensa "essa cor veio de outro sistema", ele está errado.

---

## REGRA 2 — TIPOGRAFIA: DOIS PESOS, DOIS TAMANHOS, ESQUERDA

### Estrutura obrigatória
```
NÍVEL 1 — build-up
  Peso: Light / Regular (nunca acima de Medium)
  Cor: #888888 a #999999
  Tamanho: base (referência)
  Função: contexto, narrativa, o que leva ao punch
  Tracking: normal

NÍVEL 2 — punch word(s)
  Peso: Black / Extra-Bold / Heavy (nunca abaixo de Bold)
  Cor: #0d0d0d a #111111
  Tamanho: 2.0x a 2.5x maior que Nível 1
  Função: a palavra que o usuário lembra
  Tracking: tight / -0.02em a -0.04em
```

### Posição e geometria
- Alinhamento: **esquerdo — nunca centralizado**
- Padding esquerdo: 6-8% do frame
- Largura máxima do bloco de texto: **65% do frame** — nunca toca a borda direita
- O bloco de texto nunca desce abaixo dos 55% do frame vertical
- Sem box, container, fundo, sombra, sublinhado — a letra flutua no fundo

### O que nunca fazer em tipografia
- ❌ Texto centralizado (parece template genérico)
- ❌ Texto que vai de borda a borda (90%+ da largura)
- ❌ Três ou mais pesos diferentes (confunde a hierarquia)
- ❌ Fonte com serifa
- ❌ Texto decorado (gradiente na letra, outline, glow no texto)
- ❌ Toda a tipografia no mesmo peso

---

## REGRA 3 — ELEMENTO FOCAL: UM E APENAS UM

**A imagem tem ONE hierarquia. Um elemento que responde "onde devo olhar primeiro?"**

### O focal element pode ser
- Um glass card com gráfico/métrica
- Um ícone de app 3D
- Um objeto 3D narrativo (megafone, cubo, etc.)
- O próprio bloco tipográfico (se for o hero)

### Posição do focal element
- Centro do frame (horizontal) ou levemente deslocado para direita
- Verticalmente: entre 40% e 75% do frame — abaixo do texto
- Escala: domina a atenção — não é pequeno

### O que nunca fazer
- ❌ Dois elementos de tamanho igual competindo pela atenção
- ❌ Focal element muito pequeno (abaixo de 35% da largura do frame)
- ❌ Focal element no canto (extremidades são para suporte)
- ❌ Card de dashboard + objeto 3D + chrome fragments todos no mesmo tamanho

---

## REGRA 4 — GLASS CARDS: MATERIAL, NÃO HARDWARE

### O que é um glass card (obrigatório entender)
- É um painel de vidro flutuando no espaço
- Não tem espessura de dispositivo físico
- Não tem bezel, câmera, botões, porta USB
- Não é iPad, tablet, phone, laptop
- É puro software — como uma janela de app numa tela invisível

### Parâmetros de dark glass card (REF-03, 04, 05, 06)
```
Fill: rgba(15, 25, 60, 0.65) [azul-escuro] ou rgba(20, 20, 30, 0.70) [neutral dark]
Background blur: 20-40px blur
Border: 1px rgba(255, 255, 255, 0.10)
Corner radius: 16-22px
Drop shadow: rgba(0,0,0,0.3) blur 40px, offset Y 8px — difusa, grande
```

### Parâmetros de light glass card (para fundo prata — REF-01)
```
Fill: rgba(255, 255, 255, 0.15)
Background blur: 30px
Border: 1px rgba(255, 255, 255, 0.60)
Corner radius: 16-22px
Drop shadow: rgba(0,0,0,0.08) blur 30px
```

### Light Sweep — obrigatório em todo glass card
```
Forma: faixa diagonal, ~25% da largura do card
Ângulo: 30-40° (superior-esquerdo → inferior-direito)
Cor: rgba(255, 255, 255, 0.28) a rgba(255, 255, 255, 0.35)
Blur na borda: fade suave nas extremidades da faixa
Resultado visual: reflexo de janela em cartão de crédito / vidro curvo
```

### Conteúdo do card (máximo 3 elementos internos)
- Label: Regular/Light, cinza ou branco ~70%, caps ou lowercase, ~13px
- Valor hero: Bold/Black, branco 100% ou quase-preto, ~28-36px
- Detalhe/gráfico: Regular, cinza 50%, ~12px + o elemento gráfico (linha, barra, etc.)

### Glow de borda (opcional mas poderoso — REF-28)
- Borda inferior ou todas as bordas emitem glow da cor do tema
- Intensidade: moderada — o glow define o card, não ofusca o conteúdo

---

## REGRA 5 — ELEMENTOS DE SUPORTE (antes: Chrome Fragments)

**Os elementos de suporte devem ter relação direta com o que a copy diz. Nunca são decoração genérica.**

Antes de definir os elementos de suporte, perguntar: **"o que a copy está descrevendo?"**
A resposta define o que flutua ao redor do card.

### Exemplos por contexto de copy
| Copy / Tema | Elementos de suporte adequados |
|-------------|-------------------------------|
| Caos, desordem, fragmentação | Chrome fragments, cacos metálicos |
| Venda, comércio | Ícones 3D de produto (tênis, camiseta), sacolas, tags de preço |
| Pagamento, dinheiro | Moedas 3D, símbolos Pix, recibos, cartões |
| Estoque, inventário | Caixas 3D, pacotes, código de barras |
| Estratégia, crescimento | Gráficos, setas, checkmarks |
| Ausência, vazio, "não tem" | Nenhum elemento — a composição vazia É o design |
| Tecnologia, sistema | Ícones de app, nós de rede, chips |

### Parâmetros universais (independente do tipo)
- Escala: pequenos — nenhum maior que 8% da largura do frame
- Posição: ao redor do focal element e nas bordas — nunca no centro
- Material: consistente com a paleta da peça (chrome para prata, colorido para fundo colorido)
- **Nunca** são o focal element — sempre suporte
- **Nunca** adicionar elementos de suporte sem verificar se fazem sentido com a copy

---

## REGRA 6 — ESPAÇAMENTO E COMPOSIÇÃO 9:16

### Layout padrão (fundo prata + text + UI card)
```
0% ─── padding topo
8% ─── início do texto nível 1
        [linha 1 light gray]
        [linha 2 light gray]
        [linha 3 light gray]
        [linha 4 PUNCH BLACK — maior]
        [linha 5 PUNCH BLACK]
38% ── fim do texto
        ↓
        [ZONA DE RESPIRO — ~15% do frame]
        ↓
52% ── início do focal element
        [FOCAL ELEMENT — card/objeto 3D]
        [chrome fragments ao redor]
80% ── fim do focal element
        ↓
        [BASE LIMPA — apenas reflexo difuso]
100% ─ rodapé
```

### Regras de espaçamento
- Padding lateral esquerdo: 6-8% do frame
- O texto nunca vai além de 65% da largura total
- Zona de respiro entre texto e focal: nunca menor que 10% do frame
- Os últimos 20% (rodapé) ficam limpos — só reflexo suave ou nada

---

## REGRA 7 — ILUMINAÇÃO E AMBIENTE

### Para fundo prata (Sistema A)
- Luz de estúdio overhead — branca neutra, difusa
- Rim light prata suave nas bordas dos objetos 3D
- Os objetos chrome capturam e refletem o ambiente prata
- Resultado: CGI de produto Apple, keynote slide

### Para fundo dark navy/preto (Sistemas B e C)
- Glow colorido atrás dos focal elements (azul, roxo, laranja — só um)
- Rim light branco/prata nos edges dos cards
- O glow é a única "iluminação" — sem luz ambiente genérica

### Proibido em qualquer sistema
- ❌ Chamas / fogo
- ❌ Neon colorido sem propósito
- ❌ Iluminação dramática de baixo (estilo horror)
- ❌ HDR agressivo com halos visíveis
- ❌ Bloom excessivo que apaga detalhes

---

## REGRA 8 — QUALIDADE CGI

**A imagem deve ser render fotorrealista, não design gráfico. A diferença:**

| CGI (correto) | Design Gráfico (errado) |
|--------------|------------------------|
| Materiais com reflexo de ambiente | Cores flat sem reflexo |
| Sombras com softness e penumbra | Sombras duras ou ausentes |
| Profundidade de campo sutil | Tudo em foco ao mesmo tempo |
| Elementos em planos Z diferentes | Tudo na mesma camada |
| Superfícies que interagem com a luz | Fills sólidos que não respondem à luz |
| Qualidade "Apple product page" | Qualidade "template Canva" |

---

## REGRA 9 — MOTION READINESS

**Toda peça é o primeiro frame de uma animação Higgsfield.**

### Posicionamento pensando em motion
- Focal element centralizado com espaço ao redor para flutuação
- Chrome fragments em posições que permitem orbit/drift
- Light sweep posicionado para poder deslizar diagonalmente
- O texto light → heavy implica timing (light aparece primeiro, heavy entra depois)

### O que pode animar no Higgsfield
- Glass card: float up + slight rotation
- Light sweep: deslizamento diagonal da esquerda para direita
- Chrome fragments: drift orbital lento
- Glow: pulsação suave (glow in/out)
- Tipografia: fade/slide in da esquerda

---

## REGRA 10 — PROIBIÇÕES ABSOLUTAS

Estes elementos foram explicitamente rejeitados pelo usuário ou produzem resultados ruins:

```
❌ Logo Apple (rejeitado — não é peça Apple, é conteúdo de marketing)
❌ Megafone isolado como objeto principal (é elemento de suporte secundário)
❌ Card com bezel de hardware (iPad/tablet/phone físico)
❌ Card com espessura de dispositivo (porta USB, câmera, botão físico)
❌ Três ou mais sistemas de cor no mesmo frame
❌ Botão colorido em paleta monocromática
❌ Texto vermelho de alerta em contexto silver/pearl
❌ Gradiente de fundo colorido saturado (ex: roxo→rosa, azul→verde)
❌ Texto centralizado
❌ Texto de borda a borda (>80% da largura do frame)
❌ Glow colorido no texto tipográfico
❌ Neon sem contexto
❌ Fundo escuro + elementos completamente flat sem qualquer efeito
❌ Mais de um focal element de igual hierarquia
```

---

## REGRA 11 — ACENTUAÇÃO EM PORTUGUÊS (OBRIGATÓRIO)

**Todo texto em português no prompt DEVE estar com acentuação correta. Nunca remover acentos.**

- Escrever sempre: "anúncio", "estratégia", "mês", "também", "não", "está", "é", "visível", "retorno"
- Nunca escrever: "anuncio", "estrategia", "mes", "tambem", "nao", "esta" (sem acento)
- O modelo GPT Image interpreta os acentos e os reproduz corretamente no texto gerado
- Remover acentos faz o texto da imagem sair sem acento — erro visual grave em português
- Isso se aplica a TODA copy dentro do prompt: tipografia principal, labels de cards, subtextos

**Exemplos obrigatórios:**
```
✅ "investir em anúncio"      ❌ "investir em anuncio"
✅ "sem estratégia"           ❌ "sem estrategia"
✅ "todo mês"                 ❌ "todo mes"
✅ "sem retorno visível"      ❌ "sem retorno visivel"
✅ "a mesma conta."           ✅ (já correto — sem acento mesmo)
```

---

# TEMPLATE DE PROMPT

```
[FORMAT]
Vertical 9:16, 1024x1536px. Social media post for Instagram Reels.

[QUALITY]
Photorealistic CGI render quality. Apple product page aesthetic.
Think WWDC keynote slide — not flat graphic design.

[COLOR SYSTEM — DECLARE ONCE, EVERYTHING OBEYS]
[ESCOLHER UM:]
→ Sistema A: 100% monochromatic silver. Background: pearl-silver radial gradient 
  (#f2f2f7 center, #c8c8cc edges). All 3D elements: chrome/silver/gray. 
  Typography: gray (#888) + near-black (#111). Zero hue anywhere.
→ Sistema B: Dark navy monochromatic. Background: #060b1a to #0a0f1e.
  Single accent: electric blue (#3060ff) only in glow elements.
  Typography: white. Zero other colors.
→ Sistema C: Pure black + [ONE accent color]. Background: #000 to #080808.
  Accent: [cor única]. Typography: white. One accent maximum.

[BACKGROUND]
[Descrever o fundo do sistema escolhido — gradiente, textura (none), qualidade]

[TYPOGRAPHY — LEFT ALIGNED, MAX 65% WIDTH]
Font: SF Pro Display / clean geometric sans-serif. No box, no shadow, no underline.
Level 1 (build-up lines): "[texto]" — Light/Regular weight, #888888, medium size.
Level 2 (punch): "[TEXTO PUNCH]" — Black/Heavy weight, #111111, 2.3x larger, tight tracking.
Position: upper-left area, starting at 6% from left edge, 8% from top.
Width constraint: block never exceeds 65% of frame width.

[FOCAL ELEMENT — SINGLE, DOMINANT, CENTER]
[Descrever o card/objeto com estes parâmetros:]
- What it is: [ex: dark glass analytics panel / frosted white UI card]
- Material: [ex: dark glass, rgba(15,25,60,0.65), 30px backdrop blur]
- Corner radius: [ex: 18px rounded]
- Light sweep: diagonal specular highlight crossing the panel, upper-left to lower-right, 
  white at ~30% opacity, ~25% panel width, soft blur on edges
- Glow: [ex: electric blue glow behind panel, large radius, ~50% opacity]
- Content inside: [label + hero value + data element — máximo 3 itens]
- Position: centered horizontally, vertical center to bottom-center of frame

[SUPPORTING ELEMENTS]
Chrome fragments: 5-7 small metallic shards, ultra-reflective, silver/chrome only,
scattered around focal element and frame edges, each max 7% of frame width.
No chrome fragment in the exact center — only surrounding the focal element.

[LIGHTING]
Clean studio lighting. Overhead white neutral light. Silver rim light on 3D element edges.
Elements cast soft diffuse shadows. Materials reflect the silver/pearl environment.

[HARD PROHIBITIONS FOR THIS IMAGE]
NO hardware device bezels. NO iPad, tablet, or phone physical form.
NO colored elements outside the declared color system.
NO centered text. NO text beyond 65% frame width.
NO Apple logo. NO fire or neon effects.
NO more than ONE accent color.
```

---

# ERROS DAS GERAÇÕES ANTERIORES

| # | Geração | Erro Principal | Causa | Correção no Prompt |
|---|---------|---------------|-------|-------------------|
| 1 | Fundo preto, chamas | Background escuro, elementos de fogo | Não especificou fundo claro nem proibiu fogo | Declarar Sistema A explicitamente + "NO fire" |
| 2 | Card virou iPad | Bezel de hardware, forma de tablet | "UI card" interpretado como dispositivo físico | "NOT hardware device. NOT iPad. Pure software panel floating in space." |
| 3 | Texto edge-to-edge | "sem estrategia" ~90% da largura | Sem constraint de largura | "Max 65% of frame width" |
| 4 | Rosa + vermelho + cinza | 3 sistemas de cor brigando | Gradiente Instagram + paleta prata + cor de erro | Escolher UM sistema e proibir o resto explicitamente |
| 5 | Glass card com bezel | Card ainda parecia hardware | Glassmorphism especificado mas sem proibir bezel explicitamente | Descrever material de vidro frosted + "NO device bezel, NO physical thickness, NO USB port, NO button" |

---

*Documento atualizado com análise visual de todas as imagens em .jpeg + 2 PNGs principais.*
*Total de imagens analisadas: 28 imagens visualmente inspecionadas.*
