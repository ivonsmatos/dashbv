# DashBV

Dashboard financeiro privado para ingestão de demonstrativos PDF, análise temporal e geração de insights com Groq.

## Arquitetura

- `apps/web`: React, Vite e ECharts; publicado no Cloudflare Pages.
- `apps/api`: Node.js 22 e Fastify; autenticação, métricas e agente Groq.
- `worker`: Python e PyMuPDF; varre `doc/` nos dias 1 e 16 às 02:00.
- PostgreSQL: transações, resumos mensais, auditoria de cargas e cache de insights.
- Caddy: HTTPS e proxy reverso da API.

## Desenvolvimento

```bash
cp .env.example .env
npm install
docker compose up -d db
npm run dev:api
npm run dev:web
```

## Produção

O repositório não contém PDFs, CSVs, credenciais ou dados financeiros. No servidor, coloque os demonstrativos em `/opt/dashbv/server-data/doc/` e os CSVs da carga inicial em `/opt/dashbv/data/`.

```bash
docker compose up -d --build
docker compose ps
```

Variáveis obrigatórias: `POSTGRES_PASSWORD`, `DATABASE_URL`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PUBLIC_API_HOST` e `ALLOWED_ORIGINS`. `GROQ_API_KEY` habilita o agente.

