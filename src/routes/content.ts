import { Router } from 'express';
import type { ContentService } from '../services/content.js';
import { feedQuery, postInput, postPatch, searchQuery } from '../services/content.js';
import { requireAdmin } from '../services/auth.js';
import { objectId } from '../http.js';

export function contentRouter(content: ContentService) {
  const router = Router();
  router.get('/posts', async (req, res) => { res.json(await content.list(feedQuery.parse(req.query))); });
  router.get('/posts/:postId', async (req, res) => { res.json({ data: await content.post(objectId(req.params.postId)) }); });
  router.post('/posts', requireAdmin, async (req, res) => {
    const data = await content.createPost(postInput.parse(req.body), res.locals.auth.admin._id, res.locals.requestId);
    res.status(201).location(`/api/v1/posts/${data.id}`).json({ data });
  });
  router.patch('/posts/:postId', requireAdmin, async (req, res) => {
    res.json({ data: await content.updatePost(objectId(req.params.postId), postPatch.parse(req.body), res.locals.auth.admin._id, res.locals.requestId) });
  });
  router.delete('/posts/:postId', requireAdmin, async (req, res) => {
    await content.deletePost(objectId(req.params.postId), res.locals.auth.admin._id, res.locals.requestId);
    res.status(204).end();
  });
  router.get('/group', async (_req, res) => { res.json({ data: await content.groupDto(await content.group()) }); });
  router.get('/search', async (req, res) => { res.json(await content.search(searchQuery.parse(req.query))); });
  router.get('/discover', async (req, res) => {
    const posts = await content.list(feedQuery.parse(req.query));
    res.json({ data: { group: await content.groupDto(await content.group()), posts: posts.data }, page: posts.page });
  });
  return router;
}
