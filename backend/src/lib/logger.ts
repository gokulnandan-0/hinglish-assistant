import { pino, type Logger } from 'pino';

/** PII minimisation (PRD §12): transcripts and tokens never reach logs. */
export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: ['req.headers.authorization', '*.transcript', '*.text', '*.reply', 'transcript', 'text', 'reply', '*.token'],
      censor: '[redacted]',
    },
    base: { service: 'nova-tutor' },
  });
}
