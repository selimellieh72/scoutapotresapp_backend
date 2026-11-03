import { Router } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import type { MediaService } from '../services/media.js';
import { mediaDto } from '../services/media.js';
import { requireAdmin } from '../services/auth.js';
import { HttpError, objectId } from '../http.js';

export function mediaRouter(media: MediaService, limits: boolean) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
  const uploadLimit = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Try again later.', requestId: res.locals.requestId } }),
    skip: () => !limits,
  });
  router.post('/', requireAdmin, uploadLimit, upload.single('file'), async (req, res) => {
    if (!req.file) throw new HttpError(400, 'MISSING_FILE', 'Provide one file field.');
    const asset = await media.upload(req.file.buffer, res.locals.auth.admin._id);
    res.status(201).location(`/api/v1/media/${asset._id.toHexString()}`).json({ data: mediaDto(asset) });
  });
  router.get('/:mediaId', async (req, res) => {
    const asset = await media.visible(objectId(req.params.mediaId), Boolean(res.locals.auth));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: mediaDto(asset) });
  });
  router.get('/:mediaId/file', async (req, res, next) => {
    const asset = await media.visible(objectId(req.params.mediaId), Boolean(res.locals.auth));
    if (asset.state !== 'ready') throw new HttpError(409, 'MEDIA_NOT_READY', 'Media is not ready.');
    res.setHeader('Cache-Control', 'private, no-store');
    // Published files are intentionally public; private files still require the
    // authorization check above. Allow the separate frontend origin to render them.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.type(asset.mimeType);
    // Range and HEAD requests pass through the same publication checks.
    res.sendFile(media.store.path(asset.storageKey), { cacheControl: false, acceptRanges: true, dotfiles: 'deny' }, error => {
      if (!error) return;
      if ('code' in error && error.code === 'ENOENT') return next(new HttpError(404, 'NOT_FOUND', 'Media file not found.'));
      if ('status' in error && error.status === 416) return next(new HttpError(416, 'INVALID_RANGE', 'Requested byte range is unavailable.'));
      next(error);
    });
  });
  router.delete('/:mediaId', requireAdmin, async (req, res) => {
    await media.delete(objectId(req.params.mediaId));
    res.status(204).end();
  });
  return router;
}
