import { resolve } from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/?replicaSet=rs0'),
  MONGODB_DATABASE: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('scoutapotres'),
  MEDIA_DIRECTORY: z.string().default('.data/media'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.email().optional(),
  PASSWORD_RESET_URL: z.url().optional(),
  CONTACT_EMAIL: z.email().optional(),
  PRIVACY_POLICY_URL: z.url().optional(),
  ABOUT_TEXT: z.string().default('Groupe Scout des Apôtres'),
  SUPPORTED_LANGUAGES: z.string().default(''),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const emailConfigured = Boolean(parsed.SMTP_HOST && parsed.SMTP_FROM && parsed.PASSWORD_RESET_URL);
  if (parsed.NODE_ENV === 'production' && emailConfigured &&
      !parsed.PASSWORD_RESET_URL!.startsWith('https://')) {
    throw new Error('Production PASSWORD_RESET_URL must use HTTPS.');
  }
  if (Boolean(parsed.SMTP_USER) !== Boolean(parsed.SMTP_PASSWORD)) {
    throw new Error('Set both SMTP_USER and SMTP_PASSWORD, or neither.');
  }
  return {
    ...parsed,
    MEDIA_DIRECTORY: resolve(parsed.MEDIA_DIRECTORY),
    corsOrigins: parsed.CORS_ORIGINS.split(',').map(x => x.trim()).filter(Boolean),
    supportedLanguages: parsed.SUPPORTED_LANGUAGES.split(',').map(x => x.trim()).filter(Boolean),
    emailConfigured,
  };
}

export type Config = ReturnType<typeof loadConfig>;
