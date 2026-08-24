import fs from 'node:fs';
import path from 'node:path';
import type { Transcriber } from '../ingress/inbound.js';

/**
 * Groq Whisper transcription (whisper-large-v3-turbo). The key lives here
 * only; the transcript is the only thing that travels upward.
 */
export class GroqTranscriber implements Transcriber {
  constructor(
    private readonly apiKey: string,
    private readonly model = 'whisper-large-v3-turbo',
  ) {}

  async transcribe(absolutePath: string): Promise<string> {
    const form = new FormData();
    const bytes = fs.readFileSync(absolutePath);
    form.append('file', new Blob([bytes]), path.basename(absolutePath));
    form.append('model', this.model);
    form.append('response_format', 'text');
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Groq transcription failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
    return (await res.text()).trim();
  }
}
