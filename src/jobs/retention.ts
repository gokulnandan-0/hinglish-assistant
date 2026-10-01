import type { Deps } from '../deps.js';

/**
 * Deletes opt-in learner audio past AUDIO_RETENTION_DAYS (PRD §12: 30-90 day retention).
 * The storage account lifecycle rule (infra) is the backstop if this job doesn't run.
 */
export function startRetentionJob(deps: Deps, everyMs = 3_600_000): () => void {
  const run = async () => {
    const lock = await deps.redis.set('job:retention', '1', 'EX', 600, 'NX');
    if (lock !== 'OK') return;
    try {
      for (;;) {
        const batch = await deps.repo.expiredAudio(200);
        if (batch.length === 0) break;
        for (const row of batch) {
          await deps.audioStore.delete(row.audio_url);
          await deps.repo.clearAudio(row.id);
        }
      }
    } catch (err) {
      deps.log.error({ err }, 'retention job failed');
    } finally {
      await deps.redis.del('job:retention');
    }
  };
  const timer = setInterval(() => void run(), everyMs);
  void run();
  return () => clearInterval(timer);
}
