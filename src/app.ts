import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import type { Config } from './config.js';
import type { Database } from './db.js';
import type { MediaStore } from './storage/local.js';
import type { ResetMailer } from './services/email.js';
import { AuthService } from './services/auth.js';
import { ContentService } from './services/content.js';
import { MediaService } from './services/media.js';
import { authRouter, meRouter } from './routes/auth.js';
import { contentRouter } from './routes/content.js';
import { mediaRouter } from './routes/media.js';
import { errorHandler, HttpError, notFound, requestIdentity } from './http.js';

export interface AppDependencies {
  db: Database;
  config: Config;
  store: MediaStore;
  mailer?: ResetMailer;
  rateLimits?: boolean;
}

export function createApp({ db, config, store, mailer, rateLimits = true }: AppDependencies) {
  const app = express();
  const auth = new AuthService(db, mailer);
  const content = new ContentService(db);
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(requestIdentity, helmet());
  app.use(cors({ origin: config.corsOrigins, allowedHeaders: ['Content-Type', 'Authorization'], methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));
  app.use(express.json({ limit: '128kb' }));
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.get('/ready', async (_req, res) => {
    try { await db.db.command({ ping: 1 }, { timeoutMS: 2000 }); }
    catch { throw new HttpError(503, 'NOT_READY', 'Service is not ready.'); }
    res.json({ status: 'ready' });
  });
  const api = express.Router();
  api.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Try again later.', requestId: res.locals.requestId } }),
    skip: () => !rateLimits,
  }));
  api.use(auth.optionalAuthentication);
  api.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use('/auth', authRouter(auth, rateLimits));
  api.use('/me', meRouter);
  api.use('/media', mediaRouter(new MediaService(db, store), rateLimits));
  api.get('/app-info', (_req, res) => { res.json({ data: {
    about: config.ABOUT_TEXT, contactEmail: config.CONTACT_EMAIL ?? null,
    privacyPolicyUrl: config.PRIVACY_POLICY_URL ?? null, supportedLanguages: config.supportedLanguages,
  } }); });
  api.use(contentRouter(content));
  app.use('/api/v1', api);
  app.use(() => { throw notFound(); });
  app.use(errorHandler);
  return app;
}
