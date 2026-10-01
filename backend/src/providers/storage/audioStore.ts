import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import type { Env } from '../../config/env.js';

/** Wrap 16 kHz mono 16-bit PCM in a WAV header (Custom Speech training accepts WAV). */
export function pcmToWav(pcm: Buffer, sampleRate = 16_000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface AudioStore {
  /** Returns the blob URL (not a SAS: access is via managed identity only). */
  putUtterance(learnerId: string, sessionId: string, seq: number, pcm: Buffer): Promise<string>;
  delete(url: string): Promise<void>;
  deleteLearner(learnerId: string): Promise<number>;
}

/**
 * Learner audio is stored ONLY with explicit consent (off by default, PRD §12). Blobs live in the
 * Central India storage account; a lifecycle-management rule (see infra) deletes them after
 * AUDIO_RETENTION_DAYS as a backstop to the application-level purge job.
 */
export class BlobAudioStore implements AudioStore {
  private readonly container: ContainerClient;

  constructor(env: Env) {
    const service = env.AZURE_STORAGE_CONNECTION_STRING
      ? BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING)
      : new BlobServiceClient(env.AZURE_STORAGE_ACCOUNT_URL!, new DefaultAzureCredential());
    this.container = service.getContainerClient(env.AUDIO_CONTAINER);
  }

  async putUtterance(learnerId: string, sessionId: string, seq: number, pcm: Buffer): Promise<string> {
    const blob = this.container.getBlockBlobClient(`${learnerId}/${sessionId}/${String(seq).padStart(4, '0')}.wav`);
    await blob.uploadData(pcmToWav(pcm), { blobHTTPHeaders: { blobContentType: 'audio/wav' } });
    return blob.url;
  }

  async delete(url: string): Promise<void> {
    const name = decodeURIComponent(new URL(url).pathname.split('/').slice(2).join('/'));
    await this.container.deleteBlob(name, { deleteSnapshots: 'include' }).catch((err) => {
      if (err?.statusCode !== 404) throw err;
    });
  }

  async deleteLearner(learnerId: string): Promise<number> {
    let n = 0;
    for await (const b of this.container.listBlobsFlat({ prefix: `${learnerId}/` })) {
      await this.container.deleteBlob(b.name, { deleteSnapshots: 'include' });
      n++;
    }
    return n;
  }
}

export class DisabledAudioStore implements AudioStore {
  async putUtterance(): Promise<string> {
    throw new Error('audio storage not configured');
  }
  async delete(): Promise<void> {}
  async deleteLearner(): Promise<number> {
    return 0;
  }
}
