# Nova tutor backend

A voice-first English speaking tutor for Indian learners, built on Azure. Stack: TypeScript, Node 22, Fastify, WebSocket.
It implements `../ai-spoken-english-tutor-docs.md`, with the model-flow changes explained in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- **[docs/AZURE_REQUIREMENTS.md](docs/AZURE_REQUIREMENTS.md):** which Azure resources to create and which keys go into `.env`
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md):** model analysis, turn pipeline, protocol, compliance, evaluation

## Quick start
```bash
npm install
cp .env.example .env         # fill in the Speech and Azure OpenAI keys (see docs/AZURE_REQUIREMENTS.md)
npm run db:up                # local PostgreSQL :5433 + Redis :6380
npm run smoke                # checks Speech TTS→STT+PA loopback, LLM JSON streaming and Content Safety
npm run dev                  # migrates, seeds scenarios, listens on :8080
```

## Scripts
| Command | What it does |
|---|---|
| `npm test` | Unit tests, plus the e2e WebSocket turn test against local PG/Redis with fake Azure providers |
| `npm run typecheck` / `npm run build` | TypeScript checks and build |
| `npm run eval -- pron [file]` | Offline pronunciation-policy metrics per L1 |
| `npm run eval -- stt manifest.jsonl` | WER per L1 through the production recognizer (needs keys) |
| `npm run eval -- llm` | Prompt regression suite and TTFT (needs keys; exits non-zero on failure) |
| `npm run smoke` | Connectivity check for each Azure dependency |

## Layout
```
src/
  config/env.ts               env schema (zod): every key the app reads
  routes/rest.ts              PRD §7 REST API
  ws/                         WebSocket protocol + handler
  orchestrator/sessionPipeline.ts   the turn: STT → triage → LLM stream → TTS stream → persist
  domain/pronunciation/       phoneme mapping, policy loader, deterministic selector
  domain/tutor/               prompts, JSON schema, streaming JSON scanner, sentence splitter, summary
  domain/profile/mastery.ts   error-profile EMA + observations
  providers/                  speech | tts | llm | safety | storage (each behind an interface)
  db/                         migrations, repository, seed
config/                       pronunciation.json (thresholds, accepted variants, L1 priority), scenarios.json, pricing.json
eval/                         evaluation harness + fixtures
infra/main.bicep              IaC (Central India + South India); dev.bicepparam
```

## Deploy
```bash
docker build -t <acr>.azurecr.io/nova-tutor-backend:<tag> .
NOVA_PG_PASSWORD=... az deployment group create -g rg-nova-dev -f infra/main.bicep -p infra/dev.bicepparam -p containerImage=<image>
```
Create one resource group per environment: dev, staging, prod. In prod, Speech, OpenAI and Content Safety run with local (key) auth disabled, and the app authenticates with its managed identity.
