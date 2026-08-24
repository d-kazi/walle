/**
 * Thin fetch wrapper for the Meta Graph API. Holds the token; nothing above
 * this layer ever sees it. Injectable for tests.
 */
export interface GraphClient {
  post(path: string, body: unknown): Promise<Record<string, unknown>>;
  get(path: string): Promise<Record<string, unknown>>;
  /** raw GET returning bytes, for media downloads */
  getBinary(url: string): Promise<Buffer>;
}

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

export function createGraphClient(token: string): GraphClient {
  const headers = { Authorization: `Bearer ${token}` };
  return {
    async post(path: string, body: unknown) {
      const res = await fetch(`${GRAPH_BASE}${path}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(`Graph POST ${path} failed: ${res.status} ${JSON.stringify(json)}`);
      }
      return json;
    },
    async get(path: string) {
      const res = await fetch(`${GRAPH_BASE}${path}`, { headers });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(`Graph GET ${path} failed: ${res.status} ${JSON.stringify(json)}`);
      }
      return json;
    },
    async getBinary(url: string) {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
