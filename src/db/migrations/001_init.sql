-- PRD §8 data model. PostgreSQL 16 (Azure Database for PostgreSQL Flexible Server, Central India).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE learners (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Subject claim from the identity provider (Entra External ID). No phone/email stored here (PII minimisation).
  external_subject       text NOT NULL UNIQUE,
  display_name           text,
  age_band               text NOT NULL CHECK (age_band IN ('kid', 'teen', 'adult')),
  l1                     text NOT NULL,
  cefr_level             text NOT NULL CHECK (cefr_level IN ('A1','A2','B1','B2','C1','C2')),
  consent_parental       boolean NOT NULL DEFAULT false,
  consent_parental_at    timestamptz,
  consent_parental_ref   text,          -- reference to the verifiable-consent record (DPDP Act §9)
  consent_audio_storage  boolean NOT NULL DEFAULT false,
  preferred_voice        text NOT NULL DEFAULT 'conversation' CHECK (preferred_voice IN ('conversation', 'clear')),
  streak_days            integer NOT NULL DEFAULT 0,
  last_active_date       date,
  created_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz
);

CREATE TABLE scenarios (
  id            text PRIMARY KEY,
  title         text NOT NULL,
  level         text NOT NULL CHECK (level IN ('A1','A2','B1','B2','C1','C2')),
  role          text NOT NULL,
  goal          text NOT NULL,
  target_vocab  text[] NOT NULL DEFAULT '{}',
  opening_line  text NOT NULL,
  safety_notes  text NOT NULL DEFAULT '',
  audience      text NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'kids', 'adults')),
  active        boolean NOT NULL DEFAULT true
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_id   uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  mode         text NOT NULL CHECK (mode IN ('tutor', 'roleplay', 'drill')),
  scenario_id  text REFERENCES scenarios(id),
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  summary_json jsonb
);
CREATE INDEX sessions_learner_idx ON sessions (learner_id, started_at DESC);

CREATE TABLE turns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  transcript    text NOT NULL,
  reference     text,
  scores_json   jsonb NOT NULL,
  llm_json      jsonb,
  latency_json  jsonb NOT NULL,
  cost_json     jsonb,
  prompt_version text NOT NULL,
  audio_url     text,
  audio_expires_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);
CREATE INDEX turns_audio_expiry_idx ON turns (audio_expires_at) WHERE audio_url IS NOT NULL;

CREATE TABLE error_profile (
  learner_id  uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  category    text NOT NULL CHECK (category IN ('grammar', 'phoneme', 'vocab')),
  key         text NOT NULL,
  count       integer NOT NULL DEFAULT 0,
  last_seen   timestamptz NOT NULL DEFAULT now(),
  mastery     real NOT NULL DEFAULT 0.5 CHECK (mastery >= 0 AND mastery <= 1),
  PRIMARY KEY (learner_id, key)
);

-- Audit trail for DPDP deletion requests (kept without PII after the learner row is purged).
CREATE TABLE deletion_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_hash  text NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  blobs_deleted integer NOT NULL DEFAULT 0
);
