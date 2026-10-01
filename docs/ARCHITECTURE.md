# Nova tutor backend: architecture and model-flow decisions

## 1. Model-flow analysis (PRD §1, §4, §5) and what changed

The PRD's cascaded flow is correct at its core: en-IN STT with Pronunciation Assessment, then the LLM, then en-IN Neural TTS. The research found four places where the flow as written would not work, or would be slow. Each is fixed below.

| # | PRD assumption | What Microsoft docs say (Sept 2026) | Change |
|---|---|---|---|
| 1 | en-IN assessment returns phoneme names and "heard" phonemes (`{"p":"θ","heard":"t"}`) plus prosody | IPA phoneme names, NBest spoken phonemes and prosody are **en-US only**. en-IN returns word and phoneme *scores* but no phoneme identity. | **Dual-lane assessment** (see below) |
| 2 | "Return ONLY JSON" **and** "start TTS on the first sentence while the LLM continues" | These conflict: a JSON reply can't be spoken until it has been parsed | **Streaming JSON extraction** of `reply` |
| 3 | The LLM picks the pronunciation issue to coach | The PRD also asks for "one issue per turn" and "never flag accepted Indian variants". An LLM choosing from raw scores does both unreliably. | **Deterministic pronunciation triage** in code; the LLM only phrases the tip |
| 4 | Speech, the LLM and Content Safety all in one Indian region | Speech is **not offered in South India**; Azure OpenAI and Content Safety are listed only in **South India** | Speech/data/compute in Central India; LLM and safety in South India |

**Speech-to-speech (gpt-realtime / Voice Live) was considered and rejected for v1.** These models cannot do pronunciation assessment, which is the core feature. They are only offered as Global/DataZone deployments in India, so there is no in-India processing option. They would also still need a parallel Speech recognizer for scoring. The cascaded pipeline, with streaming at every stage, meets the ≤ 1.5 s budget.

### 1.1 Dual-lane pronunciation assessment
```
PCM ──┬─▶ en-IN recognizer + PA (unscripted/scripted) ─▶ transcript, partials, word accuracy, fluency  [critical path]
      └─▶ en-US recognizer + PA (IPA, NBest=3, prosody) ─▶ phoneme names, heard-as, prosody             [≤ 350 ms grace]
                                  │
                  align by audio timestamp + same word text ─▶ merged WordResult[]
```
- Both lanes consume the same stream in parallel, so the en-US lane adds **no latency** once speech ends. If it misses the 350 ms grace window, the turn goes ahead without it (metric `pron.detail_missed`).
- The **word** score, which decides whether a word is flagged at all, always comes from **en-IN**, so it is accent-tolerant. The en-US lane only says *which sound* was off. Its phoneme scores get `enUsPhonemeCalibration` points added, because the en-US model is harsher on Indian speech. Calibrate this against human ratings.
- A word is enriched only when both lanes recognised the **same word**. For example, en-IN "prepone" vs en-US "prepare" is left alone.
- Cost: STT audio minutes double. `PRON_DETAIL_MODE=single` turns the second lane off.

### 1.2 Streaming structured output
Structured outputs emit keys in schema order: `safety_flag → correction → reply → pron_tip → next_prompt → practised_correctly → scene_complete`.
- `TopLevelJsonStream` (`src/domain/tutor/jsonStream.ts`) streams the characters of `reply` into `SentenceSplitter`. The first sentence goes to TTS while the model is still writing.
- `safety_flag` arrives first (about 5 tokens), so an escalation suppresses the audio before any is released.
- `correction` comes before `reply`, so the model commits to the fix before weaving it into the spoken reply.
- Validation follows the PRD: zod checks, one retry, then a plain reply. There is one extra guard: **no retry once the learner has heard part of a reply**.

### 1.3 Deterministic pronunciation triage (`src/domain/pronunciation/selector.ts`)
PRD §10 is implemented as code driven by config (`config/pronunciation.json`):
1. Threshold per L1 and age band, with a bonus for high-frequency words.
2. Drop **accepted variants**: retroflex t/d, v/w merger, rhotic r. /θ ð/ as dental stops are down-weighted.
3. Match **intelligibility rules**: vowel length (ship/sheep, full/fool), z/dʒ, s/ʃ, f/p, dropped final consonants, s-cluster epenthesis, omissions (drills only).
4. Rank by impact, then learner frequency (from the error profile), then the L1 priority table.
5. Pick **one** word. The LLM receives only `"sheep (score 42): /i/ sounded like /ɪ/; coaching hint: ..."`, and any `pron_tip` for a different word is discarded.

Hinglish words and Indian proper nouns are never flagged, and they are also fed to the STT phrase list. Code-switching is handled by the en-IN model plus this neutral list rather than by language ID: Microsoft doesn't document language ID combined with Pronunciation Assessment.

## 2. Components
```
Mobile ─WS/REST─▶ Container Apps (Fastify)                          Central India
                    ├─ auth (Entra External ID JWT)
                    ├─ REST: learners, sessions, scenarios, summary, tts preview, deletion
                    └─ WS /v1/sessions/{id}/stream ─▶ SessionPipeline (per connection)
                          ├─ AzureSpeechRecognizer (en-IN + en-US lanes) ──▶ Azure Speech   Central India
                          ├─ selectPronunciationFocus (config)
                          ├─ AzureOpenAiLlm (v1, stream, json_schema) ─────▶ Azure OpenAI   South India
                          ├─ AzureContentSafety (parallel gate) ──────────▶ Content Safety South India
                          ├─ AzureTts (warm synthesizer, per-sentence) ───▶ Azure Speech   Central India
                          └─ persist: PostgreSQL · Redis · Blob (opt-in) · App Insights
```
Every vendor sits behind an interface (`src/providers/*/types.ts`), so Sarvam, AI4Bharat or ElevenLabs can be tried later without touching the orchestrator (PRD §16).

## 3. Turn timeline and latency budget
| Stage | Mechanism | Budget |
|---|---|---|
| Endpointing | `Speech_SegmentationSilenceTimeoutMs`: A1 900 ms down to C2 500 ms, +150 ms for kids (server mode); or push-to-talk `end_utterance` | 400-900 ms |
| STT final + assessment | Streaming recognition, so only the last segment is pending | 200-300 ms |
| Input safety | Runs **in parallel** with the LLM; audio is buffered until it clears | 0 ms on the critical path |
| LLM first sentence | Streaming, `reasoning_effort=none`, `max_completion_tokens=300`, stable system prompt (prompt caching) | 400-600 ms |
| TTS first chunk | Synthesizer pre-connected when the session opens, Opus 24 kHz output | 150-250 ms |

`turn_end.latency_ms` reports `stt_finalize`, `llm_first_token`, `llm_first_sentence`, `first_audio` (from end of speech), `llm_total` and `total`. Histograms go to App Insights.

## 4. WebSocket protocol (`src/ws/protocol.ts`)
- **Client → server:**
  - `audio` (base64, or binary frames of 16 kHz/16-bit/mono PCM)
  - `end_utterance`
  - `set_reference`
  - `clear_reference`
  - `interrupt` (barge-in)
  - `config {turn_detection: server|client, binary_audio}`
  - `end_session`
  - `ping`
- **Server → client (PRD §7):** `partial_transcript`, `final_transcript` (words carry `highlight`, and `scores_are_estimates: true`), `feedback`, `audio {seq, sentence, last}`, `turn_end`, `error {code, retryable}`.
- **Extra server messages:**
  - `ready`
  - `reply_text` (a caption per sentence)
  - `model_audio`: the clear-voice model pronunciation that starts the coaching loop
  - `session_summary`
- **Auth:** `Authorization: Bearer`, the `?access_token=` query parameter, or `Sec-WebSocket-Protocol: bearer, <token>`.
- **Coaching loop (PRD §10.5):**
  1. After a `pron_tip`, the server sends `model_audio` for the word.
  2. The client sends `set_reference`, and the next utterance is assessed as a scripted drill.
  3. `feedback.drill` reports `{attempt, passed (≥ 75), done}`, allowing up to 3 attempts.

## 5. Data and compliance
- **Schema:** `src/db/migrations/001_init.sql` (PRD §8). The error profile uses the PRD's EMA, and the top 3 lowest-mastery items go into the prompt. "Correct" observations come from well-produced tracked phonemes and from the LLM's `practised_correctly`.
- **DPDP:**
  - Minors need `consent.parental` plus a verifiable consent reference before they can have a learner record or a session.
  - Audio storage is off by default. It is opt-in, with an app-level purge job plus a storage lifecycle rule.
  - `DELETE /v1/learners/{id}/data` cascades through the DB, deletes blobs and keeps an anonymised audit row.
  - Logs redact transcripts, replies and tokens.
  - The identity provider holds phone numbers; the DB stores only the `sub` claim.
- **Safety:**
  - Kids use a stricter Azure OpenAI filter (a separate deployment) and a stricter Content Safety profile, with output checked per sentence before audio is released.
  - Self-harm triggers the escalation template (Tele-MANAS 14416) instead of the model's reply.
  - The tutor never claims to be human.

## 6. Evaluation (`eval/`, PRD §13)
- `npm run eval -- pron [fixture.jsonl]`: flag precision/recall, false-flag rate on accepted variants, and focus agreement per L1. Runs offline, on every config change.
- `npm run eval -- stt manifest.jsonl`: WER per L1 and age band through the production recognizer (target ≤ 15%), plus the detail-lane miss rate.
- `npm run eval -- llm`: prompt regression. Checks one correction at most, no correction of valid Indian English ("prepone"), a pron tip only for the chosen word, reply length, kids' PII refusal, and TTFT p50. Exits non-zero on failure, for CI.
- `npm run smoke`: a loopback through every Azure dependency, run after the keys are added.
