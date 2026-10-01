import type { Redis } from 'ioredis';
import type { ChatMessage } from '../providers/llm/types.js';

const TTL = 2 * 3600;
const HISTORY_TURNS = 8;

export interface DrillState {
  reference: string;
  focusWord: string | null;
  attempt: number;
  /** Set when the drill was started from a tutor-turn pron_tip (coaching loop, PRD §10.5). */
  origin: 'client' | 'coaching';
}

/** Short-lived, per-session state in Azure Cache for Redis (PRD §6). */
export class SessionState {
  constructor(private readonly redis: Redis) {}

  /** One live stream per session; returns false if another connection holds it. */
  async acquireStream(sessionId: string, connId: string): Promise<boolean> {
    return (await this.redis.set(`sess:${sessionId}:stream`, connId, 'EX', 60, 'NX')) === 'OK';
  }

  async refreshStream(sessionId: string, connId: string): Promise<void> {
    const cur = await this.redis.get(`sess:${sessionId}:stream`);
    if (cur === connId) await this.redis.expire(`sess:${sessionId}:stream`, 60);
  }

  async releaseStream(sessionId: string, connId: string): Promise<void> {
    const cur = await this.redis.get(`sess:${sessionId}:stream`);
    if (cur === connId) await this.redis.del(`sess:${sessionId}:stream`);
  }

  async history(sessionId: string): Promise<ChatMessage[]> {
    const raw = await this.redis.lrange(`sess:${sessionId}:history`, 0, -1);
    return raw.map((r) => JSON.parse(r) as ChatMessage);
  }

  /** Keep the last N user/assistant pairs; the assistant side stores only the spoken reply to save tokens. */
  async appendHistory(sessionId: string, user: string, assistant: string): Promise<void> {
    const key = `sess:${sessionId}:history`;
    await this.redis
      .multi()
      .rpush(key, JSON.stringify({ role: 'user', content: user }), JSON.stringify({ role: 'assistant', content: assistant }))
      .ltrim(key, -HISTORY_TURNS * 2, -1)
      .expire(key, TTL)
      .exec();
  }

  async getDrill(sessionId: string): Promise<DrillState | null> {
    const raw = await this.redis.get(`sess:${sessionId}:drill`);
    return raw ? (JSON.parse(raw) as DrillState) : null;
  }

  async setDrill(sessionId: string, drill: DrillState | null): Promise<void> {
    if (drill) await this.redis.set(`sess:${sessionId}:drill`, JSON.stringify(drill), 'EX', TTL);
    else await this.redis.del(`sess:${sessionId}:drill`);
  }

  /** Fixed-window per-learner turn limit (PRD §12). */
  async allowTurn(learnerId: string, perMinute: number): Promise<boolean> {
    const key = `rl:turn:${learnerId}:${Math.floor(Date.now() / 60_000)}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 70);
    return n <= perMinute;
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.redis.del(`sess:${sessionId}:history`, `sess:${sessionId}:drill`);
  }
}
