import { z } from 'zod';

/**
 * The only file that reads process.env. Everything downstream takes a Config.
 * Secrets live here and in the clients that use them; they are never placed
 * in model context (hard rule 3).
 */

const envSchema = z.object({
  META_WA_TOKEN: z.string().min(1),
  META_WA_PHONE_ID: z.string().min(1),
  META_WA_VERIFY_TOKEN: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  /** WhatsApp Business Account id; optional, used only to surface template approval in /health */
  META_WABA_ID: z.string().optional(),
  WA_ID_DAN: z.string().min(1),
  WA_ID_ALINA: z.string().min(1),

  LLM_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  LLM_API_KEY: z.string().min(1),
  WALLE_MODEL: z.string().default('deepseek/deepseek-chat'),
  WALLE_MODEL_ESCALATED: z.string().optional(),

  GROQ_API_KEY: z.string().min(1),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_DAN: z.string().min(1),
  GOOGLE_REFRESH_ALINA: z.string().min(1),
  GOOGLE_REFRESH_WALLE: z.string().min(1),
  FAMILY_DRIVE_FOLDER_ID: z.string().min(1),

  /** the two addresses allowed to forward mail into the walle inbox */
  EMAIL_DAN: z.string().email(),
  EMAIL_ALINA: z.string().email(),
  /** comma-separated, case-insensitive; a hit in From, Subject or body marks mail as school mail */
  SCHOOL_KEYWORDS: z.string().default('bisr'),

  LEDGER_PUSH_TOKEN: z.string().min(16),

  TZ: z.string().default('Asia/Riyadh'),
  PORT: z.coerce.number().int().default(3000),
  DATA_DIR: z.string().default('/data'),
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  env: Env;
  timezone: string;
  dataDir: string;
  port: number;
  /** every configured secret value, for the LLM-request leak guard */
  secretValues: string[];
  /** lowercased, trimmed, empties dropped */
  schoolKeywords: string[];
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const env = envSchema.parse(source);
  return {
    env,
    timezone: env.TZ,
    dataDir: env.DATA_DIR,
    port: env.PORT,
    schoolKeywords: env.SCHOOL_KEYWORDS.split(',')
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 0),
    secretValues: [
      env.META_WA_TOKEN,
      env.META_APP_SECRET,
      env.LLM_API_KEY,
      env.GROQ_API_KEY,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_REFRESH_DAN,
      env.GOOGLE_REFRESH_ALINA,
      env.GOOGLE_REFRESH_WALLE,
      env.LEDGER_PUSH_TOKEN,
    ],
  };
}
