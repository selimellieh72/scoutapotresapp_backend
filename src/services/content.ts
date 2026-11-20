import { ObjectId, type ClientSession, type Filter } from 'mongodb';
import { z } from 'zod';
import type { Database } from '../db.js';
import { HttpError, idSchema, notFound } from '../http.js';
import { categories, type GroupAccount, type Media, type Post } from '../types.js';
import { changeReferences, mediaDto } from './media.js';
import { digest } from './crypto.js';

const mediaIds = z.array(idSchema).max(1, 'Attach at most one image.')
  .refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length, 'Duplicate attachments are not allowed.');
export const postInput = z.object({ category: z.enum(categories), title: z.string().trim().max(200).default(''),
  text: z.string().trim().max(20_000).default(''), mediaIds: mediaIds.default([]) }).strict();
export const postPatch = z.object({ category: z.enum(categories).optional(), title: z.string().trim().max(200).optional(),
  text: z.string().trim().max(20_000).optional(), mediaIds: mediaIds.optional() }).strict()
  .refine(body => Object.keys(body).length > 0, 'Provide at least one field.');
export const groupPatch = z.object({ name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(), logoMediaId: idSchema.nullable().optional(),
  coverMediaId: idSchema.nullable().optional() }).strict()
  .refine(body => Object.keys(body).length > 0, 'Provide at least one field.');
const pagingFields = { category: z.enum(categories).optional(), contentType: z.enum(['text', 'image', 'video']).optional(),
  cursor: z.string().min(1).max(1000).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) };
export const feedQuery = z.object(pagingFields).strict();
export const searchQuery = z.object({ ...pagingFields, q: z.string().trim().min(2).max(200) }).strict();
type FeedQuery = z.infer<typeof feedQuery> & { q?: string };
const cursorSchema = z.object({ date: z.iso.datetime(), id: idSchema, filter: z.string() }).strict();
const escaped = (input: string) => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class ContentService {
  constructor(private readonly db: Database) {}

  private async mediaMap(ids: (ObjectId | null)[]) {
    const selected = ids.filter((id): id is ObjectId => id !== null);
    const assets = await this.db.media.find({ _id: { $in: selected }, state: 'ready', referenceCount: { $gt: 0 } }).toArray();
    return new Map(assets.map(asset => [asset._id.toHexString(), asset]));
  }

  async groupDto(group: GroupAccount) {
    const assets = await this.mediaMap([group.logoMediaId, group.coverMediaId]);
    const get = (id: ObjectId | null) => { const media = id ? assets.get(id.toHexString()) : undefined; return media ? mediaDto(media) : null; };
    return { id: group._id.toHexString(), name: group.name, description: group.description,
      logo: get(group.logoMediaId), cover: get(group.coverMediaId), updatedAt: group.updatedAt };
  }

  async groups() {
    const groups = await this.db.groups.find({ status: 'active' }).sort({ name: 1, _id: 1 }).toArray();
    return Promise.all(groups.map(group => this.groupDto(group)));
  }

  async group(id: ObjectId) {
    const group = await this.db.groups.findOne({ _id: id, status: 'active' });
    if (!group) throw notFound();
    return this.groupDto(group);
  }

  private async postDtos(posts: Post[]) {
    const groupIds = [...new Map(posts.map(post => [post.groupId.toHexString(), post.groupId])).values()];
    const groups = await this.db.groups.find({ _id: { $in: groupIds } }).toArray();
    const assets = await this.mediaMap([
      ...posts.flatMap(post => post.mediaIds),
      ...groups.map(group => group.logoMediaId),
    ]);
    const byGroup = new Map(groups.map(group => [group._id.toHexString(), group]));
    const assetDto = (id: ObjectId | null) => { const asset = id ? assets.get(id.toHexString()) : undefined; return asset ? mediaDto(asset) : null; };
    return posts.flatMap(post => {
      const group = byGroup.get(post.groupId.toHexString());
      if (!group) return [];
      return [{ id: post._id.toHexString(), category: post.category, title: post.title, text: post.text,
        group: { id: group._id.toHexString(), name: group.name, logo: assetDto(group.logoMediaId) },
        media: post.mediaIds.map(id => assets.get(id.toHexString())).filter((asset): asset is Media => Boolean(asset)).map(mediaDto),
        publishedAt: post.publishedAt, updatedAt: post.updatedAt }];
    });
  }

  async post(id: ObjectId) {
    const post = await this.db.posts.findOne({ _id: id, deletedAt: null });
    if (!post) throw notFound();
    const dto = (await this.postDtos([post]))[0];
    if (!dto) throw notFound();
    return dto;
  }

  async list(query: FeedQuery, groupId?: ObjectId) {
    const filter: Filter<Post> = { deletedAt: null, ...(groupId ? { groupId } : {}) };
    if (query.category) filter.category = query.category;
    if (query.contentType === 'text') filter.mediaIds = { $size: 0 };
    else if (query.contentType) filter.mediaTypes = query.contentType;
    if (query.q) filter.$or = [{ title: { $regex: escaped(query.q), $options: 'i' } }, { text: { $regex: escaped(query.q), $options: 'i' } }];
    const fingerprint = digest(JSON.stringify([query.category ?? null, query.contentType ?? null, query.q ?? null, groupId?.toHexString() ?? null]));
    if (query.cursor) {
      let cursor;
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
      } catch { throw new HttpError(400, 'INVALID_CURSOR', 'Pagination cursor is invalid.'); }
      if (cursor.filter !== fingerprint) throw new HttpError(400, 'INVALID_CURSOR', 'Cursor does not match the current filters.');
      const date = new Date(cursor.date);
      filter.$and = [{ $or: [{ publishedAt: { $lt: date } }, { publishedAt: date, _id: { $lt: new ObjectId(cursor.id) } }] }];
    }
    const found = await this.db.posts.find(filter, { maxTimeMS: 3000 }).sort({ publishedAt: -1, _id: -1 }).limit(query.limit + 1).toArray();
    const hasMore = found.length > query.limit;
    const page = found.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ date: last.publishedAt.toISOString(), id: last._id.toHexString(), filter: fingerprint })).toString('base64url') : null;
    return { data: await this.postDtos(page), page: { nextCursor, hasMore } };
  }

  async search(query: z.infer<typeof searchQuery>) {
    const posts = await this.list(query);
    const pattern = { $regex: escaped(query.q), $options: 'i' } as const;
    const groups = await this.db.groups.find({ status: 'active', $or: [{ name: pattern }, { description: pattern }] }).sort({ name: 1 }).limit(20).toArray();
    return { data: { groups: await Promise.all(groups.map(group => this.groupDto(group))), posts: posts.data }, page: posts.page };
  }

  private async audit(session: ClientSession, groupId: ObjectId, action: string, targetType: 'post' | 'group', targetId: ObjectId, requestId: string) {
    await this.db.audit.insertOne({ _id: new ObjectId(), actorGroupId: groupId, action, targetType, targetId, requestId, timestamp: new Date() }, { session });
  }

  async createPost(input: z.infer<typeof postInput>, groupId: ObjectId, requestId: string) {
    const id = new ObjectId();
    await this.db.transaction(async session => {
      if (!input.text && !input.mediaIds.length) throw new HttpError(400, 'EMPTY_POST', 'Provide text or an image.');
      const ids = input.mediaIds.map(id => new ObjectId(id));
      const assets = await changeReferences(this.db, [], ids, groupId, session);
      if (assets.some(asset => asset.type !== 'image')) throw new HttpError(400, 'INVALID_MEDIA', 'Posts support one image only.');
      const now = new Date();
      await this.db.posts.insertOne({ _id: id, groupId, category: input.category, title: input.title, text: input.text, mediaIds: ids,
        mediaTypes: [...new Set(assets.map(asset => asset.type))], publishedAt: now, createdAt: now, updatedAt: now, deletedAt: null }, { session });
      await this.audit(session, groupId, 'post.created', 'post', id, requestId);
    });
    return this.post(id);
  }

  async updatePost(id: ObjectId, input: z.infer<typeof postPatch>, groupId: ObjectId, requestId: string) {
    await this.db.transaction(async session => {
      const existing = await this.db.posts.findOne({ _id: id, groupId, deletedAt: null }, { session });
      if (!existing) throw notFound();
      const ids = input.mediaIds?.map(id => new ObjectId(id)) ?? existing.mediaIds;
      const text = input.text ?? existing.text;
      if (!text && !ids.length) throw new HttpError(400, 'EMPTY_POST', 'Provide text or an image.');
      const assets = await changeReferences(this.db, existing.mediaIds, ids, groupId, session);
      if (assets.some(asset => asset.type !== 'image')) throw new HttpError(400, 'INVALID_MEDIA', 'Posts support one image only.');
      await this.db.posts.updateOne({ _id: id, groupId, deletedAt: null }, { $set: { text, title: input.title ?? existing.title,
        category: input.category ?? existing.category, mediaIds: ids, mediaTypes: [...new Set(assets.map(asset => asset.type))], updatedAt: new Date() } }, { session });
      await this.audit(session, groupId, 'post.updated', 'post', id, requestId);
    });
    return this.post(id);
  }

  async deletePost(id: ObjectId, groupId: ObjectId, requestId: string) {
    await this.db.transaction(async session => {
      const post = await this.db.posts.findOne({ _id: id, groupId, deletedAt: null }, { session });
      if (!post) throw notFound();
      await changeReferences(this.db, post.mediaIds, [], groupId, session);
      const now = new Date();
      await this.db.posts.updateOne({ _id: id, groupId }, { $set: { deletedAt: now, updatedAt: now } }, { session });
      await this.audit(session, groupId, 'post.deleted', 'post', id, requestId);
    });
  }

  async updateGroup(groupId: ObjectId, input: z.infer<typeof groupPatch>, requestId: string) {
    await this.db.transaction(async session => {
      const group = await this.db.groups.findOne({ _id: groupId, status: 'active' }, { session });
      if (!group) throw notFound();
      const nextLogo = input.logoMediaId === undefined ? group.logoMediaId : input.logoMediaId ? new ObjectId(input.logoMediaId) : null;
      const nextCover = input.coverMediaId === undefined ? group.coverMediaId : input.coverMediaId ? new ObjectId(input.coverMediaId) : null;
      const before = [group.logoMediaId, group.coverMediaId].filter((id): id is ObjectId => id !== null);
      const after = [nextLogo, nextCover].filter((id): id is ObjectId => id !== null);
      const assets = await changeReferences(this.db, before, after, groupId, session);
      if (assets.some(asset => asset.type !== 'image')) throw new HttpError(400, 'INVALID_MEDIA', 'Group profile media must be images.');
      await this.db.groups.updateOne({ _id: groupId, status: 'active' }, { $set: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        logoMediaId: nextLogo, coverMediaId: nextCover, updatedAt: new Date(),
      } }, { session });
      await this.audit(session, groupId, 'group.updated', 'group', groupId, requestId);
    });
    const updated = await this.db.groups.findOne({ _id: groupId, status: 'active' });
    if (!updated) throw notFound();
    return this.groupDto(updated);
  }
}
