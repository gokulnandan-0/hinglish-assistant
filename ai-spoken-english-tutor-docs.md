# AI Spoken English Tutor ("Miss Nova"-style): Product & Backend Documentation

Target: Indian learners (kids to adults) · Cloud: Microsoft Azure · Version 0.1

---

## 1. Master Prompt (give this to a coding agent or engineer)

> Build the backend for a voice-first English-speaking tutor for **Indian learners**. The learner speaks; the system transcribes with **Azure Speech (locale en-IN)**, scores pronunciation with **Azure Pronunciation Assessment**, sends transcript + weak-phoneme data + learner profile to an **LLM tutor**, and replies with **Azure Neural TTS (Indian English voice)**. Two features: (1) **AI tutor**: instant grammar correction, pronunciation help on tricky words, personalized feedback; (2) **AI role-play**: scenario-based conversations that get learners speaking from day one. Requirements: streaming WebSocket voice pipeline, first audio ≤ 1.5 s, one or two corrections per turn only, per-learner error memory, accent-tolerant scoring (do not penalise valid Indian-English variants), child-safe content, DPDP Act-compliant storage. Deliver: REST + WebSocket API, database schema, prompt templates, evaluation harness, IaC. Follow this document.

---

## 2. Goals and Non-Goals

**Goals**
- Learners speak from lesson one, with low-anxiety, instant, specific feedback.
- Pronunciation feedback that improves **intelligibility**, not accent erasure.
- Works on low-end Android phones and 4G networks.
- Personalised: remembers each learner's recurring errors and level.

**Non-goals (v1)**: exam-grade scoring, non-English target languages, video, live human tutors.

---

## 3. Users

| Segment | Notes |
|---|---|
| Kids (UKG to Class 12) | Minors: parental consent, stricter content filter, shorter turns |
| College and job seekers | Interview and workplace role-plays |
| Adults | Daily-life and travel English |

Learner first languages: Hindi, Tamil, Telugu, Bengali, Marathi, Kannada, Malayalam, Gujarati and others. Each transfers different sounds into English, so profile the L1.

---

## 4. Indian Accent Requirements (critical)

**STT**
- Use locale **en-IN** (not en-US). Consider **Azure Custom Speech** fine-tuned on Indian-accented learner audio (with consent) if WER is high.
- Use **phrase lists** for Indian names, places, and common Hinglish words.
- **Code-switching**: learners often mix Hindi/regional words. Use Azure multi-language detection (e.g. candidates `en-IN`, `hi-IN`) and treat non-English words as neutral rather than errors.
- Benchmark WER per L1 group on a held-out set before launch. Target: WER ≤ 15% on learner speech (adjust after measuring).

**Pronunciation scoring**
- Verify current Pronunciation Assessment support for en-IN in Microsoft's docs; if a feature (e.g. prosody) is unavailable for en-IN, fall back to en-US scoring and calibrate thresholds.
- Common accepted Indian-English features (do **not** flag by default): retroflex /t, d/, v/w merger, dental stops for /θ, ð/ at low severity, syllable-timed rhythm, rhotic /r/.
- **Flag only intelligibility-affecting errors**: vowel length confusions that change words (ship/sheep), missing word stress on key words, dropped final consonants, s+consonant clusters (school → "ischool"), /z/ vs /dʒ/ confusion.
- Keep a per-L1 **error-priority table** (config, not code) that sets which phonemes to coach first.

**TTS**
- Default voice: Azure en-IN Neural voices (e.g. `en-IN-NeerjaNeural`, `en-IN-PrabhatNeural`; verify the current voice list for newer ones).
- Offer two voices: **Indian English (conversation)** and **neutral/clear slow (model pronunciation)**, so learners hear a target that is intelligible globally.
- Use SSML `<phoneme>` and custom lexicon for tricky words and Indian proper nouns.
- Hindi voices (e.g. `hi-IN-SwaraNeural`) for optional L1 hints.

**Alternatives to evaluate later** (Indic-specialised): Sarvam AI, AI4Bharat models, ElevenLabs Indian-English voices. Keep STT/TTS behind an interface so they can be swapped.

---

## 5. Architecture

```
Mobile app ──WebSocket──▶ API Gateway (Azure App Service / Container Apps)
                              │
        ┌─────────────────────┼──────────────────────┐
        ▼                     ▼                      ▼
 Azure Speech STT +      LLM Tutor Service      Azure Speech TTS
 Pronunciation Assess.   (Azure OpenAI or         (Neural, en-IN)
        │                 Claude via API)                │
        └──────────▶ Orchestrator ◀──────────────────────┘
                              │
        Cosmos DB / PostgreSQL · Redis · Blob Storage · App Insights
```

**Turn flow**
1. Client streams 16 kHz mono PCM chunks over WebSocket.
2. Server pipes audio to Speech SDK with `PronunciationAssessmentConfig` (unscripted for role-play, scripted for drills).
3. Partial transcripts stream back to the UI (live captions).
4. On final result: collect transcript, word/phoneme scores, NBest phonemes, miscue flags.
5. Build tutor prompt (see §9) and stream the LLM reply.
6. Split reply into sentences; start TTS on the first sentence while the LLM continues.
7. Stream audio back. Send a `feedback` JSON payload for the UI (highlights, correction, tip).
8. Persist turn, update learner error profile.

---

## 6. Azure Resources

| Resource | Purpose |
|---|---|
| Azure AI Speech (Central India / South India region) | STT, Pronunciation Assessment, TTS. Pick an Indian region for latency and data residency. |
| Azure OpenAI (or external LLM API) | Tutor reasoning |
| Azure Container Apps / App Service | API + WebSocket gateway |
| Azure Cosmos DB or PostgreSQL | Users, sessions, turns, error profiles |
| Azure Cache for Redis | Session state, rate limiting |
| Azure Blob Storage | Audio (opt-in, short retention) |
| Azure Key Vault | Keys and secrets |
| Application Insights | Latency, errors, cost telemetry |
| Azure AD B2C / custom auth | Login (phone OTP is common in India) |

Provision with Bicep or Terraform. Separate dev, staging, and prod.

---

## 7. API Specification

**Auth**: Bearer JWT. Short-lived Speech tokens can be issued to the client only if you choose a direct-to-Speech design; the recommended design proxies through the server.

### REST
| Method | Path | Description |
|---|---|---|
| POST | `/v1/learners` | Create learner (age band, L1, level, consent flags) |
| GET | `/v1/learners/{id}/profile` | Level, top errors, streak |
| POST | `/v1/sessions` | Start session `{mode: "tutor"|"roleplay"|"drill", scenario_id?}` |
| GET | `/v1/scenarios` | List role-play scenarios by level |
| GET | `/v1/sessions/{id}/summary` | End-of-session feedback |
| POST | `/v1/tts/preview` | Synthesize a word/sentence `{text, voice, rate}` |
| DELETE | `/v1/learners/{id}/data` | Data deletion request |

### WebSocket `/v1/sessions/{id}/stream`
Client → server
- `{"type":"audio","data":"<base64 PCM>"}` (or binary frames)
- `{"type":"end_utterance"}`
- `{"type":"set_reference","text":"..."}` (drill mode)

Server → client
- `{"type":"partial_transcript","text":"..."}`
- `{"type":"final_transcript","text":"...","words":[{"w":"think","score":54,"error":"Mispronunciation","phonemes":[{"p":"θ","score":38,"heard":"t"}]}]}`
- `{"type":"feedback","reply":"...","correction":{"original":"...","fixed":"...","why":"..."},"pron_tip":{"word":"think","tip":"..."}}`
- `{"type":"audio","data":"<base64>","seq":n}`
- `{"type":"turn_end","latency_ms":{...}}`
- `{"type":"error","code":"...","retryable":true}`

---

## 8. Data Model

- **learners**: id, age_band, l1, cefr_level, consent (parental, audio_storage), created_at
- **sessions**: id, learner_id, mode, scenario_id, started_at, ended_at
- **turns**: id, session_id, transcript, scores_json, llm_json, latency_json, audio_url?
- **error_profile**: learner_id, category (`grammar`|`phoneme`|`vocab`), key (e.g. `phoneme:θ`, `grammar:past_simple`), count, last_seen, mastery (0-1)
- **scenarios**: id, title, level, role, goal, target_vocab[], opening_line, safety_notes

Mastery update: `mastery = 0.8*mastery + 0.2*(correct ? 1 : 0)`. Surface top 3 lowest-mastery items in the tutor prompt.

---

## 9. Prompt Templates

### Tutor system prompt
```
You are "Nova", a warm, patient English speaking coach for Indian learners.
Learner: level {cefr}, first language {l1}, age band {age_band}.
Rules:
- Reply in 1-2 short sentences, then ask a follow-up to keep them talking.
- Correct at most ONE grammar mistake per turn, and ONE pronunciation issue.
- Never correct valid Indian-English usage that is intelligible and standard
  (e.g. "prepone" is fine in casual talk; flag only when it blocks understanding).
- Praise something specific first.
- Use simple words for levels A1-A2. Use an Indian context (chai, cricket,
  auto-rickshaw, exams, festivals) when giving examples.
- If the learner writes/speaks in {l1}, gently give the English and continue.
- Stay on topic and age-appropriate. Decline unsafe requests politely.
Recurring errors to work in gently: {top_errors}
Return ONLY JSON: {"reply": "", "correction": {"original":"","fixed":"","why":""} | null,
"pron_tip": {"word":"","tip":""} | null, "next_prompt": ""}
```

### Role-play addendum
```
Scenario: {title}. You play: {role}. Learner's goal: {goal}.
Target vocabulary to elicit: {target_vocab}. Stay in character.
Keep turns under 25 words. End the scene when the goal is met, then give a
3-point summary (well done, fix next, new phrases).
```

### Input block per turn
```
Transcript: "{text}"
Low-scoring words: {word: score, likely_heard}
Fluency: {n}, Completeness: {n}, Pauses: {n}
```

Validate LLM JSON; on parse failure, retry once, then fall back to a plain reply.

---

## 10. Pronunciation Logic

1. Take word-level results; keep words with accuracy < threshold (start at 60, tune per L1 and per word frequency).
2. Drop errors matching the **accepted-variant list** for en-IN (config).
3. Rank by: intelligibility impact > frequency in learner's speech > position in the L1 priority table.
4. Pick **one** word per turn. Use NBest to describe the swap ("/θ/ sounded like /t/").
5. Coaching loop: model audio (slow voice) → learner repeats (scripted assessment) → pass at ≥ 75, else retry up to 3 times, then move on.
6. Show scores as colours or stars, never as failing grades. Add a note that scores are estimates.

---

## 11. Latency Budget (target ≤ 1.5 s to first audio)

| Stage | Budget |
|---|---|
| Endpointing (silence detection) | 400-600 ms |
| Final STT + assessment | 200-300 ms |
| LLM first sentence (stream) | 400-600 ms |
| TTS first chunk | 150-250 ms |

Tactics: streaming everywhere, Indian-region deployment, warm connections, cap LLM output tokens, cache TTS for fixed phrases and word models, tune endpointing longer for beginners (they pause more).

---

## 12. Safety, Privacy, Compliance

- **DPDP Act 2023**: verifiable parental consent for under-18s, purpose limitation, deletion on request, data stored in India where feasible.
- Audio storage **off by default**; opt-in with a 30-90 day retention for quality improvement or Custom Speech training.
- Encrypt in transit and at rest; keys in Key Vault; PII minimised in logs.
- Content filtering on LLM input and output (Azure AI Content Safety) with a stricter profile for kids.
- Rate limits per learner; abuse and self-harm escalation message template.
- Never let the tutor claim to be human or give medical, legal, or financial advice.

---

## 13. Testing and Evaluation

- **Accent test set**: 200+ utterances per major L1 group, both genders, kids and adults, with human-verified transcripts.
- **Metrics**: WER by L1; pronunciation flag precision (human agreement, target ≥ 80%); false-flag rate on accepted Indian variants (target ≤ 5%); latency p50/p95; LLM correction accuracy (human-rated); learner drop-off.
- **TTS check**: 100 tricky words (Indian names, tech terms, homographs) re-transcribed by STT and reviewed by ear.
- **A/B**: voices, thresholds, correction frequency.
- Automated regression run on every prompt or threshold change.

---

## 14. Cost Model (fill from Azure pricing page)

Per active minute ≈ STT + assessment + TTS characters + LLM tokens. Track cost per turn in telemetry. Levers: cache TTS, shorter replies, smaller LLM for simple turns, batch summaries. Verify current Azure pricing and free tier before budgeting.

---

## 15. Roadmap

| Phase | Scope |
|---|---|
| 0 (2 wks) | Azure setup, en-IN STT and TTS spike, accent test set |
| 1 (4-6 wks) | Tutor mode: transcript, grammar fix, word highlights, TTS replies |
| 2 (4 wks) | Pronunciation drills with phoneme coaching, error profile |
| 3 (4 wks) | Role-play scenarios, session summaries, progress tracking |
| 4 | Custom Speech tuning, Hinglish handling, Indic-model bake-off, kids mode hardening |

---

## 16. Risks

| Risk | Mitigation |
|---|---|
| Scoring penalises Indian accent | en-IN locale, accepted-variant list, per-L1 thresholds, human calibration |
| Latency on poor networks | Indian region, streaming, low-bitrate audio, offline fallback for drills |
| LLM over-corrects or hallucinates rules | One-correction rule, JSON validation, human-reviewed eval set |
| Kids' data compliance | Consent flow, minimal retention, audits |
| Vendor lock-in | STT/TTS/LLM behind interfaces |

---

## 17. Open Questions

1. Which L1 groups launch first?
2. Kids-only, adults-only, or both at launch?
3. Should Hindi/regional-language hints be part of v1?
4. Is audio retention for model training acceptable to your users and legal team?
5. Online-only, or partial offline support?
