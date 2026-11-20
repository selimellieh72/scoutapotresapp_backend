import { randomUUID } from 'node:crypto';
import { ObjectId, type ClientSession } from 'mongodb';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import type { Database } from '../db.js';
import type { MediaStore } from '../storage/local.js';
import type { Media } from '../types.js';
import { HttpError, notFound } from '../http.js';

const unsupported = () => new HttpError(415, 'UNSUPPORTED_MEDIA', 'Upload a valid JPEG, PNG, or WebP image.');
export function mediaDto(media: Media) {
  return { id: media._id.toHexString(), type: media.type, mimeType: media.mimeType,
    sizeBytes: media.sizeBytes, width: media.width, height: media.height,
    ...(media.durationSeconds === undefined ? {} : { durationSeconds: media.durationSeconds }),
    state: media.state, url: `/api/v1/media/${media._id.toHexString()}/file` };
}

export async function changeReferences(db: Database, before: ObjectId[], after: ObjectId[], ownerGroupId: ObjectId, session: ClientSession) {
  const uniqueAfter = [...new Map(after.map(id => [id.toHexString(), id])).values()];
  const assets = await db.media.find({ _id: { $in: uniqueAfter }, uploadedByGroupId: ownerGroupId, state: 'ready' }, { session }).toArray();
  if (assets.length !== uniqueAfter.length) throw new HttpError(400, 'INVALID_MEDIA', 'Every attachment must be a ready media asset.');
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

  async upload(buffer: Buffer, uploadedByGroupId: ObjectId): Promise<Media> {
    let detected;
    try { detected = await fileTypeFromBuffer(buffer); } catch { throw unsupported(); }
    if (!detected || !['image/jpeg', 'image/png', 'image/webp'].includes(detected.mime)) throw unsupported();
    if (buffer.length > 10 * 1024 * 1024) throw new HttpError(413, 'UPLOAD_TOO_LARGE', 'Image exceeds the 10 MB limit.');
    const storageKey = `${randomUUID()}.webp`;
    const now = new Date();
    const media: Media = { _id: new ObjectId(), uploadedByGroupId, storageKey,
      type: 'image', mimeType: 'image/webp',
      sizeBytes: 0, width: 0, height: 0, state: 'processing', referenceCount: 0, createdAt: now, updatedAt: now };
    await this.db.media.insertOne(media);
    try {
      let output;
      try { output = await sharp(buffer, { limitInputPixels: 40_000_000, failOn: 'warning' }).rotate().webp({ quality: 85 }).toBuffer({ resolveWithObject: true }); }
      catch { throw unsupported(); }
      media.width = output.info.width; media.height = output.info.height; media.sizeBytes = output.data.length;
      await this.store.put(storageKey, output.data);
      media.state = 'ready'; media.updatedAt = new Date();
      await this.db.media.updateOne({ _id: media._id }, { $set: { state: 'ready', width: media.width, height: media.height,
        sizeBytes: media.sizeBytes, updatedAt: media.updatedAt } });
      return media;
    } catch (error) {
      await this.store.remove(storageKey).catch(() => {});
      await this.db.media.updateOne({ _id: media._id }, { $set: { state: 'failed', updatedAt: new Date() } });
      throw error;
    }
  }

  async visible(id: ObjectId, viewerGroupId?: ObjectId) {
    const media = await this.db.media.findOne({ _id: id, $or: [
      { state: 'ready', referenceCount: { $gt: 0 } },
      ...(viewerGroupId ? [{ uploadedByGroupId: viewerGroupId, state: { $ne: 'deleting' as const } }] : []),
    ] });
    if (!media) throw notFound();
    return media;
  }

  async delete(id: ObjectId, ownerGroupId: ObjectId) {
    // Claim the asset before touching disk; attachment transactions write the same
    // document, so deletion cannot race an attachment into a dangling reference.
    const media = await this.db.media.findOneAndUpdate({ _id: id, uploadedByGroupId: ownerGroupId,
      referenceCount: 0, state: { $in: ['ready', 'failed'] } },
      { $set: { state: 'deleting', updatedAt: new Date() } });
    if (!media) {
      if (await this.db.media.findOne({ _id: id, uploadedByGroupId: ownerGroupId })) throw new HttpError(409, 'MEDIA_IN_USE', 'Media is referenced or processing.');
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
