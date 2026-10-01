import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../config/env.js';

export interface AuthContext {
  subject: string;
  claims: JWTPayload;
}

export type Verifier = (token: string) => Promise<AuthContext>;

/**
 * Bearer JWT verification (PRD §7). Production tokens come from Microsoft Entra External ID
 * (phone-OTP / email sign-in); we only keep the `sub` claim, never the phone number.
 * AUTH_DEV_SECRET enables HS256 tokens for local development and tests.
 */
export function createVerifier(env: Env): Verifier {
  const jwks = env.AUTH_JWKS_URL ? createRemoteJWKSet(new URL(env.AUTH_JWKS_URL)) : null;
  const devKey = env.AUTH_DEV_SECRET && env.NODE_ENV !== 'production' ? new TextEncoder().encode(env.AUTH_DEV_SECRET) : null;
  return async (token) => {
    const opts = { issuer: env.AUTH_ISSUER, audience: env.AUTH_AUDIENCE };
    let payload: JWTPayload | undefined;
    if (jwks) {
      try {
        payload = (await jwtVerify(token, jwks, opts)).payload;
      } catch (err) {
        if (!devKey) throw err;
      }
    }
    if (!payload && devKey) payload = (await jwtVerify(token, devKey, { algorithms: ['HS256'] })).payload;
    if (!payload?.sub) throw new Error('token has no subject');
    return { subject: payload.sub, claims: payload };
  };
}
