import fs from 'node:fs';
import path from 'node:path';
import type { MediaFetcher } from '../types.js';
import type { GraphClient } from './client.js';

const EXT_BY_MIME: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/amr': 'amr',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * Download WhatsApp media within Meta's retention window and store under
 * DATA_DIR/media/. Returns the path relative to DATA_DIR (the log's
 * media_ref format).
 */
export class WhatsAppMediaFetcher implements MediaFetcher {
  constructor(
    private readonly graph: GraphClient,
    private readonly dataDir: string,
  ) {}

  async download(mediaId: string, mimeType: string | undefined): Promise<string> {
    const meta = await this.graph.get(`/${mediaId}`);
    const url = meta.url as string;
    const bytes = await this.graph.getBinary(url);
    const baseMime = (mimeType ?? (meta.mime_type as string) ?? '').split(';')[0]!.trim();
    const ext = EXT_BY_MIME[baseMime] ?? 'bin';
    const rel = path.join('media', `${mediaId}.${ext}`);
    const abs = path.join(this.dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    return rel;
  }
}
