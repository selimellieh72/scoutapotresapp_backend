import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { adminDto, AuthService, requireAdmin } from '../services/auth.js';

export function authRouter(auth: AuthService, limits: boolean) {
  const router = Router();
  const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Try again later.', requestId: res.locals.requestId } }),
    skip: () => !limits,
  });
  router.use(limiter);
  const identifier = z.string().trim().min(1).max(254);
  const password = z.string().min(1).max(256);
  router.post('/login', async (req, res) => {
    const body = z.object({ identifier, password }).strict().parse(req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: await auth.login(body.identifier, body.password) });
  });
  router.post('/refresh', async (req, res) => {
    const body = z.object({ refreshToken: z.string().max(128) }).strict().parse(req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: await auth.refresh(body.refreshToken) });
  });
  router.post('/logout', async (req, res) => {
    const body = z.object({ refreshToken: z.string().max(128) }).strict().parse(req.body);
    await auth.logout(body.refreshToken);
    res.status(204).end();
  });
  router.post('/forgot-password', async (req, res) => {
    const body = z.object({ identifier }).strict().parse(req.body);
    await auth.forgotPassword(body.identifier);
    res.json({ data: { message: 'If an active account exists, recovery instructions will be sent.' } });
  });
  router.post('/reset-password', async (req, res) => {
    const body = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: z.string().min(12).max(256) }).strict().parse(req.body);
    await auth.resetPassword(body.token, body.password);
    res.json({ data: { message: 'Password reset successfully.' } });
  });
  return router;
}

export const meRouter = Router().get('/', requireAdmin, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: adminDto(res.locals.auth.admin) });
});
