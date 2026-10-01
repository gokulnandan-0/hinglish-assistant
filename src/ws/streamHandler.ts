import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Deps } from '../deps.js';
import { SessionPipeline, type Transport } from '../orchestrator/sessionPipeline.js';
import { ClientMessageSchema, type ServerMessage } from './protocol.js';

const MAX_FRAME_BYTES = 64 * 1024;

/**
 * WebSocket /v1/sessions/{id}/stream (PRD §7).
 *
 * Auth: browsers and many mobile WS clients can't set headers, so the bearer token is accepted either
 * as `Authorization: Bearer` or as the `access_token` query parameter / `Sec-WebSocket-Protocol`
 * ("bearer, <token>").
 *
 * Audio out: JSON `audio` messages with base64 by default; after `{"type":"config","binary_audio":true}`
 * audio is sent as binary frames: [u32 seq][u16 sentence][u8 last][u8 reserved][payload].
 */
export function registerStream(app: FastifyInstance, deps: Deps): void {
  app.get<{ Params: { id: string }; Querystring: { access_token?: string } }>(
    '/v1/sessions/:id/stream',
    { websocket: true },
    async (socket: WebSocket, req) => {
      const connId = randomUUID();
      const closeWith = (code: string, wsCode = 4000) => {
        socket.send(JSON.stringify({ type: 'error', code, retryable: false } satisfies ServerMessage));
        socket.close(wsCode, code);
      };

      const token = bearerFrom(req.headers.authorization, req.query.access_token, req.headers['sec-websocket-protocol']);
      if (!token) return closeWith('unauthorized', 4401);
      let subject: string;
      try {
        subject = (await deps.verify(token)).subject;
      } catch {
        return closeWith('unauthorized', 4401);
      }

      const session = await deps.repo.getSession(req.params.id);
      const learner = session ? await deps.repo.getLearner(session.learnerId) : null;
      if (!session || !learner || learner.externalSubject !== subject) return closeWith('not_found', 4404);
      if (session.endedAt) return closeWith('session_ended', 4409);
      if (!(await deps.state.acquireStream(session.id, connId))) return closeWith('stream_already_open', 4409);
      const scenario = session.scenarioId ? await deps.repo.getScenario(session.scenarioId) : null;

      let binaryAudio = false;
      const send = (msg: ServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      const transport: Transport = {
        send,
        sendAudio(chunk, meta) {
          if (socket.readyState !== socket.OPEN) return;
          if (binaryAudio) {
            const header = Buffer.alloc(8);
            header.writeUInt32BE(meta.seq, 0);
            header.writeUInt16BE(meta.sentence, 4);
            header.writeUInt8(meta.last ? 1 : 0, 6);
            socket.send(Buffer.concat([header, chunk]), { binary: true });
          } else {
            send({ type: 'audio', data: chunk.toString('base64'), seq: meta.seq, sentence: meta.sentence, mime: meta.mime, last: meta.last });
          }
        },
      };

      const log = deps.log.child({ sessionId: session.id, connId });
      const pipeline = new SessionPipeline({ ...deps, log }, learner, session, scenario, transport);
      const heartbeat = setInterval(() => void deps.state.refreshStream(session.id, connId), 20_000);

      // Queue messages until init() completes so early audio isn't lost.
      let ready: Promise<void> = pipeline.init().catch((err) => {
        log.error({ err }, 'pipeline init failed');
        closeWith('init_failed', 1011);
      });

      socket.on('message', (data: Buffer, isBinary: boolean) => {
        ready = ready.then(() => handle(data, isBinary)).catch((err) => log.warn({ err }, 'message handling failed'));
      });

      const handle = async (data: Buffer, isBinary: boolean) => {
        if (data.length > MAX_FRAME_BYTES * 2) return send({ type: 'error', code: 'frame_too_large', retryable: false });
        if (isBinary) return pipeline.onAudio(data);
        let parsed;
        try {
          parsed = ClientMessageSchema.safeParse(JSON.parse(data.toString('utf8')));
        } catch {
          return send({ type: 'error', code: 'bad_json', retryable: false });
        }
        if (!parsed.success) return send({ type: 'error', code: 'bad_message', message: parsed.error.issues[0]?.message, retryable: false });
        const msg = parsed.data;
        switch (msg.type) {
          case 'audio': {
            const pcm = Buffer.from(msg.data, 'base64');
            if (pcm.length > MAX_FRAME_BYTES) return send({ type: 'error', code: 'frame_too_large', retryable: false });
            return pipeline.onAudio(pcm);
          }
          case 'end_utterance':
            return pipeline.endUtterance();
          case 'set_reference':
            return pipeline.setReference(msg.text);
          case 'clear_reference':
            return pipeline.clearReference();
          case 'interrupt':
            return pipeline.interrupt();
          case 'config':
            if (msg.turn_detection) pipeline.setTurnDetection(msg.turn_detection);
            if (msg.binary_audio !== undefined) binaryAudio = msg.binary_audio;
            return;
          case 'end_session':
            await pipeline.finishSession();
            socket.close(1000, 'session_ended');
            return;
          case 'ping':
            return send({ type: 'pong' });
        }
      };

      socket.on('close', () => {
        clearInterval(heartbeat);
        void pipeline.close().finally(() => deps.state.releaseStream(session.id, connId));
      });
    },
  );
}

function bearerFrom(header: string | undefined, query: string | undefined, protocol: string | string[] | undefined): string | null {
  if (header?.startsWith('Bearer ')) return header.slice(7);
  if (query) return query;
  const p = Array.isArray(protocol) ? protocol.join(',') : protocol;
  if (p) {
    const parts = p.split(',').map((s) => s.trim());
    const i = parts.indexOf('bearer');
    if (i >= 0 && parts[i + 1]) return parts[i + 1]!;
  }
  return null;
}
