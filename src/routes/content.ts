import { Router } from 'express';
import type { ContentService } from '../services/content.js';
import { feedQuery, groupPatch, postInput, postPatch, searchQuery } from '../services/content.js';
import { requireGroup } from '../services/auth.js';
import { objectId } from '../http.js';

export function contentRouter(content: ContentService) {
  const router = Router();
  router.get('/posts', async (req, res) => { res.json(await content.list(feedQuery.parse(req.query))); });
  router.get('/posts/:postId', async (req, res) => { res.json({ data: await content.post(objectId(req.params.postId)) }); });
  router.get('/me/posts', requireGroup, async (req, res) => {
    res.json(await content.list(feedQuery.parse(req.query), res.locals.auth.group._id));
  });
  router.post('/posts', requireGroup, async (req, res) => {
    const data = await content.createPost(postInput.parse(req.body), res.locals.auth.group._id, res.locals.requestId);
    res.status(201).location(`/api/v1/posts/${data.id}`).json({ data });
  });
  router.patch('/posts/:postId', requireGroup, async (req, res) => {
    res.json({ data: await content.updatePost(objectId(req.params.postId), postPatch.parse(req.body), res.locals.auth.group._id, res.locals.requestId) });
  });
  router.delete('/posts/:postId', requireGroup, async (req, res) => {
    await content.deletePost(objectId(req.params.postId), res.locals.auth.group._id, res.locals.requestId);
    res.status(204).end();
  });
  router.get('/groups', async (_req, res) => { res.json({ data: await content.groups() }); });
  router.get('/groups/:groupId', async (req, res) => { res.json({ data: await content.group(objectId(req.params.groupId)) }); });
  router.patch('/me/group', requireGroup, async (req, res) => {
    res.json({ data: await content.updateGroup(res.locals.auth.group._id, groupPatch.parse(req.body), res.locals.requestId) });
  });
  router.get('/search', async (req, res) => { res.json(await content.search(searchQuery.parse(req.query))); });
  router.get('/discover', async (req, res) => {
    const posts = await content.list(feedQuery.parse(req.query));
    res.json({ data: { groups: await content.groups(), posts: posts.data }, page: posts.page });
  });
  return router;
}
