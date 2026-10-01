import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import type { Env } from '../../config/env.js';

let credential: TokenCredential | undefined;

/**
 * Key auth when AZURE_SPEECH_KEY is set (simplest to start); otherwise Entra ID via the
 * custom-domain endpoint + managed identity (recommended for production: no keys to rotate).
 */
export function createSpeechConfig(env: Env): sdk.SpeechConfig {
  if (env.AZURE_SPEECH_KEY) {
    return env.AZURE_SPEECH_ENDPOINT
      ? sdk.SpeechConfig.fromEndpoint(new URL(env.AZURE_SPEECH_ENDPOINT), env.AZURE_SPEECH_KEY)
      : sdk.SpeechConfig.fromSubscription(env.AZURE_SPEECH_KEY, env.AZURE_SPEECH_REGION);
  }
  credential ??= new DefaultAzureCredential();
  return sdk.SpeechConfig.fromEndpoint(new URL(env.AZURE_SPEECH_ENDPOINT!), credential as never);
}
