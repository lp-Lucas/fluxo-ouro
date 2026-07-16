# Fluxo Ouro

Editor de vídeo web all-in-one assistido por IA. Recebe um vídeo bruto e entrega o
vídeo final exportado **sem nenhum software de edição externo** — tudo no site.

Visão completa: ver [precontext](./precontext).

## Arquitetura (uso interno / poucos usuários)

```
frontend/   SITE — React + Vite (roda no navegador)
backend/    Trabalho pesado — Node/Express + Python (whisper) + render Remotion
shared/     Tipos compartilhados (timeline JSON = fonte única, versionável)
```

Por que existe um backend mesmo sendo "um site": faster-whisper é Python, o export
final do Remotion precisa de Node+ffmpeg, e as chaves das APIs (Seedance/Gemini) não
podem ficar no navegador. O usuário só vê o site; o servidor faz o pesado.

> Estruturado para virar um app desktop (Electron) no futuro sem reescrever:
> basta empacotar `frontend/` + `backend/` rodando localmente.

## Como rodar (dev)

```bash
# frontend
cd frontend && npm install && npm run dev

# backend (outro terminal)
cd backend && npm install && npm run dev
```

## Estado atual

Apenas o esqueleto. Módulos do pipeline são implementados **um de cada vez**.
Regras invioláveis: nada de editor externo; FLOW sempre editável manualmente;
geração de imagem sempre via camada de provider abstraída (`ImageProvider`).
