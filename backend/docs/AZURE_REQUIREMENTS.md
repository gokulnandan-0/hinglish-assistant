# Azure requirements: what to provision and which env keys to hand over

This is the checklist for creating the Azure resources the backend needs. For each item it gives the variables that go into `.env` and the reason for it. Facts were checked against Microsoft Learn in September 2026. Anything marked **verify** could not be confirmed from the docs and must be checked in the portal.

> **Regions matter.** Azure Speech is **not available in South India**. Azure OpenAI and Content Safety are listed **only in South India** (Central India is not listed for them).
> Use **Central India** for Speech, data and compute, and **South India** for the LLM and Content Safety. Both regions are in India.

---

## 1. Azure AI Speech: required
**Resource:** Speech service (kind `SpeechServices`), SKU **S0**, region **Central India**. Give it a **custom domain name**, which Entra ID auth requires.

| Env var | Value |
|---|---|
| `AZURE_SPEECH_REGION` | `centralindia` |
| `AZURE_SPEECH_KEY` | Key 1 from *Keys and Endpoint*. Leave empty in prod to use managed identity. |
| `AZURE_SPEECH_ENDPOINT` | `https://<custom-domain>.cognitiveservices.azure.com/` |

**Used for:**
- **en-IN speech-to-text**, with live partial captions and phrase lists for Indian names and Hinglish words.
- **Pronunciation Assessment.** en-IN is supported, both scripted and unscripted.
- **Neural TTS**:
  - Voices: `en-IN-NeerjaNeural` for conversation, `en-IN-PrabhatNeural` at 0.85× as the slow "clear" model voice, and `hi-IN-SwaraNeural` for L1 hints.
  - Central India also offers HD and "Indic" en-IN voices (for example `en-IN-AartiIndicNeural`), which are worth A/B testing.

**Why two locales run in parallel (`PRON_DETAIL_MODE=dual`):**
- For en-IN, Microsoft does **not** return phoneme names (IPA), the "heard-as" phonemes (NBest) or prosody. All three are **en-US only**.
- Without them, the PRD's `{"p":"θ","heard":"t"}` feedback and rules like "ship vs sheep" or "z vs dʒ" are impossible.
- So the backend runs en-IN as the primary lane, for an accent-tolerant transcript and word scores. An en-US lane assesses the same audio for phoneme detail. The two are aligned by timestamp.
- **Cost impact:** STT audio minutes are billed twice, because both lanes are charged. Set `PRON_DETAIL_MODE=single` to halve STT cost and lose phoneme-level coaching.

**Quota to request:** concurrent real-time STT connections of at least **4× peak concurrent learners**, since each learner uses 2 recognition lanes plus 1 TTS connection with headroom. The S0 default is 100 concurrent requests (**verify** the current default in the portal). Raise it via a support ticket before launch.

**Later (phase 4):** a Custom Speech model on consented learner audio. Put its endpoint id in `AZURE_SPEECH_CUSTOM_ENDPOINT_ID`.

---

## 2. Azure OpenAI (Foundry): required
**Resource:** Azure OpenAI (or AI Foundry) resource in **South India**, with a custom domain. The backend calls the **v1 API** (`<endpoint>/openai/v1/`), so no api-version is needed.

| Env var | Value |
|---|---|
| `AZURE_OPENAI_ENDPOINT` | `https://<resource>.openai.azure.com` |
| `AZURE_OPENAI_API_KEY` | Key 1. Leave empty in prod to use managed identity (role *Cognitive Services OpenAI User*). |
| `AZURE_OPENAI_TUTOR_DEPLOYMENT` | `tutor-fast` |
| `AZURE_OPENAI_KIDS_DEPLOYMENT` | `tutor-kids` |
| `AZURE_OPENAI_SUMMARY_DEPLOYMENT` | `tutor-summary` |
| `AZURE_OPENAI_REASONING_EFFORT` | `none` for gpt-5.x; empty for gpt-4o |

**Deployments to create:**

| Deployment | Model (recommended) | Deployment type | Why |
|---|---|---|---|
| `tutor-fast` | **gpt-5.4-mini** | Data Zone Standard | Runs on every learner turn, so it must be fast and cheap. GA, retires 2027-09-21. |
| `tutor-kids` | same model | same | The same model with the **stricter content filter** `kids-strict` attached (block at *Low* severity). The kids age band routes here. |
| `tutor-summary` | **gpt-5.4** (or gpt-5.4-mini) | Data Zone Standard | End-of-session summaries. Not latency-critical, so it can be higher quality. |

**Data residency decision, for legal (PRD §12 / DPDP):**
- **Data Zone Standard** keeps processing within the data zone, which may be outside India.
- **Regional Standard**, which processes in India, is only offered for **gpt-4o** and **gpt-4.1-mini** in South India.
- gpt-4.1-mini is *deprecated*: new subscriptions can't deploy it, and it retires 2027-04-14.
- If legal requires in-India processing, deploy **gpt-4o, Regional Standard** for `tutor-fast` and `tutor-kids`, and set `AZURE_OPENAI_REASONING_EFFORT=` (empty).
- **Avoid** gpt-4.1-nano (retires 2026-10-14), gpt-4o-mini (deprecated) and gpt-5-mini/nano (retire 2027-02-09).

**Verify:**
- **Structured outputs:** the docs' structured-outputs model list doesn't mention gpt-5.4 yet. After the keys are in, run `npm run smoke`, which reports `llm.ok`. If a deployment rejects `json_schema`, set `AZURE_OPENAI_RESPONSE_FORMAT=json_object`. The backend validates the JSON either way.
- **Latency:** Microsoft publishes no time-to-first-token figures. `npm run eval -- llm` reports TTFT p50 per case. The latency budget allows about **≤ 400 ms TTFT**.

**Quota (TPM):**
- Estimate: peak concurrent learners × about 4 turns/min × about 1,800 tokens per turn (prompt plus history plus about 150 output tokens).
- Example: 200 concurrent learners need about 1.5M TPM on `tutor-fast`.
- Request it on the deployment's quota page.

**Content filter policy:**
- Create a custom filter `kids-strict`: Hate, Sexual, Violence and Self-harm, on both prompt and completion, blocking at **Low**. Use **asynchronous (streaming) filter mode** to keep latency down.
- Making filters stricter needs no approval; only loosening them does.
- **Optional:** apply for *modified abuse monitoring*, so prompts from minors aren't retained for human review.

---

## 3. Azure AI Content Safety: strongly recommended
**Resource:** Content Safety, SKU **S0**, region **South India**.

| Env var | Value |
|---|---|
| `AZURE_CONTENT_SAFETY_ENDPOINT` | `https://<name>.cognitiveservices.azure.com` |
| `AZURE_CONTENT_SAFETY_KEY` | Key 1. Leave empty for managed identity. |

**Why:**
- Checks learner input with `text:analyze` plus **Prompt Shields** (jailbreak detection).
- Checks kids' output sentence by sentence before audio is released.
- Drives the self-harm escalation message (PRD §12).
- These checks run in parallel with the LLM, so they add no latency.
- **Note:** Content Safety is not trained on Hindi. Add Hinglish cases to the eval set.
- Without it, the backend falls back to the Azure OpenAI deployment filter and logs a warning.

---

## 4. Platform resources: created by `infra/main.bicep`
These are not model keys, but the app needs them.

| Resource (region) | Env var(s) | Purpose |
|---|---|---|
| Azure Database for PostgreSQL Flexible Server 16 (Central India) | `DATABASE_URL`, `DATABASE_SSL=true` | Learners, sessions, turns, error profile |
| Azure Managed Redis (Central India) | `REDIS_URL` (`rediss://:<key>@<host>:10000`) | Session history, drill state, rate limits, TTS cache |
| Storage account with container `learner-audio` (Central India) | `AZURE_STORAGE_ACCOUNT_URL` | Opt-in audio only, with a lifecycle rule that deletes after `AUDIO_RETENTION_DAYS` |
| Application Insights | `APPLICATIONINSIGHTS_CONNECTION_STRING` | Latency, cost-per-turn and error telemetry |
| Key Vault (Central India) | none | Holds the DB and Redis connection strings for Container Apps |
| Container Apps with a user-assigned managed identity | `AZURE_CLIENT_ID` | API and WebSocket gateway. The identity gets RBAC on Speech, OpenAI, Content Safety, Storage and Key Vault. |

---

## 5. Identity: required for production
**Microsoft Entra External ID** tenant for customer sign-in: phone OTP (common in India) or email.

| Env var | Value |
|---|---|
| `AUTH_JWKS_URL` | `https://<tenant>.ciamlogin.com/<tenant-id>/discovery/v2.0/keys` |
| `AUTH_ISSUER` | `https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0` |
| `AUTH_AUDIENCE` | Application (client) ID of the API app registration |

For local development only, set `AUTH_DEV_SECRET` and sign HS256 tokens. It is ignored when `NODE_ENV=production`.

---

## 6. Minimum set to start developing
1. A Speech key and region (Central India).
2. An Azure OpenAI endpoint and key with one deployment named `tutor-fast`. Point `AZURE_OPENAI_SUMMARY_DEPLOYMENT` at the same deployment until you create `tutor-summary`.
3. Optionally, a Content Safety endpoint and key.
4. Run `docker compose up -d`, then `npm run smoke`. The smoke test reports whether each service works and whether the phoneme-detail lane is returning data.
