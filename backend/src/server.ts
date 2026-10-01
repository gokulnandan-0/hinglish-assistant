import Fastify, { type FastifyBaseLogger } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import type { Deps } from './deps.js';
import { registerRest } from './routes/rest.js';
import { registerStream } from './ws/streamHandler.js';

export async function buildServer(deps: Deps) {
  const app = Fastify({ loggerInstance: deps.log as unknown as FastifyBaseLogger, trustProxy: true, bodyLimit: 64 * 1024 });
  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', redis: deps.redis });
  await app.register(websocket, {
    options: {
      maxPayload: 256 * 1024,
      perMessageDeflate: false, // PCM/Opus don't compress; deflate only adds latency
      // Echo the "bearer" subprotocol when the token is passed via Sec-WebSocket-Protocol.
      handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false),
    },
  });
  registerRest(app, deps);
  registerStream(app, deps);
  return app;
}
