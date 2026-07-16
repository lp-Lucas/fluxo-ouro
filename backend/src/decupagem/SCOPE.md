# Decupagem — escopos SEPARADOS (não no caminho de corte)

## Correção de mishear por nomes próprios (item #4 — NÃO implementado de propósito)

"crux" (48s do vídeo 5a4c6524) é o transcritor ouvindo errado o **nome do produto**. A IA
acertou ao MANTER: "palavra real, provável nome mal captado, não é muleta". **Cortar
destruiria fala boa** — o apresentador falou certo, o Whisper ouviu errado.

Se o objetivo é a **legenda correta** (não um corte), isso é **correção de transcrição**,
um módulo à parte:

- `data/nomes_proprios.txt` por projeto (nome do produto, marcas, jargão).
- Corrige a transcrição PÓS-whisper por proximidade lexical (Levenshtein), ANTES de
  qualquer camada de corte.
- **Nunca** toca o caminho de decupagem. Não é corte; é ortografia da legenda.

Registrado como dívida de escopo. Implementar só sob pedido explícito.
