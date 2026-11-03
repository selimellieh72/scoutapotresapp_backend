import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ObjectId, type ClientSession } from 'mongodb';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import ffprobe from '@ffprobe-installer/ffprobe';
import type { Database } from '../db.js';
import type { MediaStore } from '../storage/local.js';
import type { Media } from '../types.js';
import { HttpError, notFound } from '../http.js';

const run = promisify(execFile);
const unsupported = () => new HttpError(415, 'UNSUPPORTED_MEDIA', 'Upload a valid JPEG, PNG, WebP, or MP4 file.');
export function mediaDto(media: Media) {
  return { id: media._id.toHexString(), type: media.type, mimeType: media.mimeType,
    sizeBytes: media.sizeBytes, width: media.width, height: media.height,
    ...(media.durationSeconds === undefined ? {} : { durationSeconds: media.durationSeconds }),
    state: media.state, url: `/api/v1/media/${media._id.toHexString()}/file` };
}

export async function changeReferences(db: Database, before: ObjectId[], after: ObjectId[], session: ClientSession) {
  const uniqueAfter = [...new Map(after.map(id => [id.toHexString(), id])).values()];
  const assets = await db.media.find({ _id: { $in: uniqueAfter }, state: 'ready' }, { session }).toArray();
  if (assets.length !== uniqueAfter.length) throw new HttpError(400, 'INVALID_MEDIA', 'Every attachment must be a ready media asset.');
  const uploaders = [...new Map(assets.map(asset => [asset.uploadedByAdminId.toHexString(), asset.uploadedByAdminId])).values()];
  const activeUploaders = await db.admins.countDocuments({ _id: { $in: uploaders }, status: 'active', role: 'admin' }, { session });
  if (activeUploaders !== uploaders.length) throw new HttpError(400, 'INVALID_MEDIA', 'Media must have been uploaded by an active admin.');
  const changes = new Map<string, number>();
  for (const id of before) changes.set(id.toHexString(), (changes.get(id.toHexString()) ?? 0) - 1);
  for (const id of after) changes.set(id.toHexString(), (changes.get(id.toHexString()) ?? 0) + 1);
  for (const [id, delta] of changes) {
    if (!delta) continue;
    const result = await db.media.updateOne({ _id: new ObjectId(id), state: 'ready',
      referenceCount: { $gte: Math.max(0, -delta) } },
      { $inc: { referenceCount: delta }, $set: { updatedAt: new Date() } }, { session });
    if (!result.matchedCount) throw new HttpError(409, 'MEDIA_CONFLICT', 'Media changed; retry the request.');
  }
  return assets;
}

export class MediaService {
  constructor(private readonly db: Database, readonly store: MediaStore) {}

  async upload(buffer: Buffer, uploadedByAdminId: ObjectId): Promise<Media> {
    let detected;
    try { detected = await fileTypeFromBuffer(buffer); } catch { throw unsupported(); }
    if (!detected || !['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(detected.mime)) throw unsupported();
    const isImage = detected.mime.startsWith('image/');
    if (buffer.length > (isImage ? 10 : 100) * 1024 * 1024) throw new HttpError(413, 'UPLOAD_TOO_LARGE', 'File exceeds its media-type limit.');
    const storageKey = `${randomUUID()}.${isImage ? 'webp' : 'mp4'}`;
    const now = new Date();
    const media: Media = { _id: new ObjectId(), uploadedByAdminId, storageKey,
      type: isImage ? 'image' : 'video', mimeType: isImage ? 'image/webp' : 'video/mp4',
      sizeBytes: 0, width: 0, height: 0, state: 'processing', referenceCount: 0, createdAt: now, updatedAt: now };
    await this.db.media.insertOne(media);
    try {
      if (isImage) {
        let output;
        try { output = await sharp(buffer, { limitInputPixels: 40_000_000, failOn: 'warning' }).rotate().webp({ quality: 85 }).toBuffer({ resolveWithObject: true }); }
        catch { throw unsupported(); }
        media.width = output.info.width; media.height = output.info.height; media.sizeBytes = output.data.length;
        await this.store.put(storageKey, output.data);
      } else {
        await this.store.put(storageKey, buffer);
        let probe;
        try {
          const result = await run(ffprobe.path, ['-v', 'error', '-protocol_whitelist', 'file,pipe',
            '-show_streams', '-show_format', '-of', 'json', this.store.path(storageKey)], { timeout: 15_000, maxBuffer: 1024 * 1024 });
          probe = JSON.parse(result.stdout) as { streams?: { codec_type?: string; width?: number; height?: number }[]; format?: { duration?: string } };
        } catch { throw unsupported(); }
        const video = probe.streams?.find(stream => stream.codec_type === 'video');
        const duration = Number(probe.format?.duration);
        if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0) throw unsupported();
        media.width = video.width; media.height = video.height;
        media.durationSeconds = duration; media.sizeBytes = buffer.length;
      }
      media.state = 'ready'; media.updatedAt = new Date();
      await this.db.media.updateOne({ _id: media._id }, { $set: { state: 'ready', width: media.width, height: media.height,
        sizeBytes: media.sizeBytes, ...(media.durationSeconds === undefined ? {} : { durationSeconds: media.durationSeconds }), updatedAt: media.updatedAt } });
      return media;
    } catch (error) {
      await this.store.remove(storageKey).catch(() => {});
      await this.db.media.updateOne({ _id: media._id }, { $set: { state: 'failed', updatedAt: new Date() } });
      throw error;
    }
  }

  async visible(id: ObjectId, isAdmin: boolean) {
    const media = await this.db.media.findOne({ _id: id, ...(isAdmin ? { state: { $ne: 'deleting' as const } } : { state: 'ready' as const, referenceCount: { $gt: 0 } }) });
    if (!media) throw notFound();
    return media;
  }

  async delete(id: ObjectId) {
    // Claim the asset before touching disk; attachment transactions write the same
    // document, so deletion cannot race an attachment into a dangling reference.
    const media = await this.db.media.findOneAndUpdate({ _id: id, referenceCount: 0, state: { $in: ['ready', 'failed'] } },
      { $set: { state: 'deleting', updatedAt: new Date() } });
    if (!media) {
      if (await this.db.media.findOne({ _id: id })) throw new HttpError(409, 'MEDIA_IN_USE', 'Media is referenced or processing.');
      throw notFound();
    }
    try { await this.store.remove(media.storageKey); }
    catch (error) {
      await this.db.media.updateOne({ _id: id, state: 'deleting' }, { $set: { state: media.state, updatedAt: new Date() } });
      throw error;
    }
    await this.db.media.deleteOne({ _id: id, state: 'deleting' });
  }
}
