# Scout des Apôtres backend

Express 5 + TypeScript + the official MongoDB driver. One Scout group, public
guest browsing, and multiple admin accounts for publishing. The app uses fixed
group branding. No likes, comments, reposts, following, messaging, reader
accounts, or competition module are implemented.

The [backend specification](docs/backend-spec.md) records the agreed scope and
the remaining product/deployment decisions.

## Requirements

- Node.js 24 and pnpm 11.25.0 (also pinned in `package.json`).
- A MongoDB replica set or Atlas cluster. Transactions protect media references,
  publishing, audit writes, and password resets. A standalone MongoDB is rejected.
- Docker Compose is optional, for the local database described below.

## Local setup

```sh
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d --wait
pnpm dev
```

If using Atlas or an existing replica set, skip Docker and set `MONGODB_URI` in
`.env`. The Compose database is bound to localhost, persists in a Docker volume,
and initializes a one-member replica set. It is a local-development setup; the
Node service runs on the host, not inside that Compose network.

The API defaults to `http://localhost:3000/api/v1`. Startup creates indexes and
the single group profile; it does **not** create admin accounts or sample posts.

```sh
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:3000/api/v1/posts
curl http://localhost:3000/api/v1/group
```

For a physical phone, configure the React Native client with your development
machine's reachable LAN address. Media URLs are relative to the API origin;
resolve them against that same origin, not against `/api/v1` a second time.

## Admin accounts remain an open product decision

There is deliberately no signup endpoint, admin invitation endpoint, bootstrap
command, or default account. Existing admin records can authenticate, but the
real account-provisioning process must be agreed before admin features are usable
outside tests. Login supports normalized email or an optional normalized username.
Usernames must not contain `@`, which distinguishes email login.

Integration tests create their own admin fixtures directly inside a disposable
database. Those credentials are test data only and are never seeded by startup.

## API

All paths below use `/api/v1`. Protected routes require
`Authorization: Bearer <accessToken>`. Guest reads omit that header. Supplying an
invalid/expired token returns `401` even for public routes; retry public reads
without it. Unknown endpoints return `404`.

| Method | Path | Access |
| --- | --- | --- |
| POST | `/auth/login` | Public; `{ identifier, password }` |
| POST | `/auth/refresh` | Refresh token in `{ refreshToken }` |
| POST | `/auth/logout` | Refresh token in `{ refreshToken }` |
| POST | `/auth/forgot-password` | Public; `{ identifier }` |
| POST | `/auth/reset-password` | `{ token, password }` |
| GET | `/me` | Admin |
| GET | `/posts` | Public |
| GET | `/posts/:postId` | Public |
| POST | `/posts` | Admin |
| PATCH | `/posts/:postId` | Admin |
| DELETE | `/posts/:postId` | Admin |
| GET | `/group` | Public |
| GET | `/search?q=...` | Public |
| GET | `/discover` | Public |
| GET | `/app-info` | Public |
| POST | `/media` | Admin; multipart `file` |
| GET | `/media/:mediaId` | Published media: public; otherwise admin |
| GET/HEAD | `/media/:mediaId/file` | Same publication check; supports byte ranges |
| DELETE | `/media/:mediaId` | Admin; only unreferenced assets |

`GET /health` and `GET /ready` are outside the versioned API. `/ready` returns
`503` if the database is unavailable.

### Publishing

```json
{
  "category": "atelier",
  "title": "Atelier du samedi",
  "text": "Retour sur notre atelier.",
  "mediaIds": []
}
```

Category is one of `article`, `atelier`, `installation`, `jeux`. A post requires
text or ready media; a title alone is insufficient. Titles are limited to 200
characters, text to 20,000, and attachments to 10 unique assets. Unknown fields
are rejected. Text is plain text. PATCH validates the resulting complete post;
`mediaIds`, when provided, replaces the entire ordered attachment list.

Public posts contain the group identity, content, media, `publishedAt`, and
`updatedAt`. Internal admin attribution is never returned publicly. All active
admins can edit/delete any post. Soft deletion removes a post from all public
queries. Edits retain the original publication date and feed position.

### Feed and search

`/posts` accepts `category`, `contentType`, `limit`, and `cursor`. Default page
size is 20; maximum is 100. Sort order is publication date then ID, both descending.
Keep the same filters when using `page.nextCursor`. Lists return
`{ data: [...], page: { nextCursor, hasMore } }`.

`contentType=text` selects posts without media. `image` and `video` match posts
with at least one asset of that type; mixed posts can match either. Category and
content-type filters combine with AND.

`/search` also requires `q` (2-200 characters) and returns
`{ data: { groups: [...], posts: [...] }, page: ... }`. Search uses bounded,
escaped, case-insensitive literal matching, not arbitrary regex or relevance
ranking. The group result has zero or one entry. `/discover` returns
`{ data: { group: {...}, posts: [...] }, page: ... }` with recent posts.

### Read-only group metadata

`GET /group` and the group fields in existing read responses remain available
for older clients. The mobile app bundles its name and logo and shows no group
profile screen. There is no group mutation endpoint.

## Authentication details

Access tokens are opaque, random, and valid for 15 minutes. Sessions last at most
30 days. Token hashes are stored in MongoDB; this implementation does not use
JWTs. Every protected request checks the current session and active admin, so
logout, account disabling, and password reset prevent protected access immediately.

Refresh rotates both tokens and invalidates the previous access token. The mobile
client must serialize refresh requests: replaying a used refresh token, including
a simultaneous second refresh, revokes the session and requires login again.
Sessions are also capped at 5,000 refreshes. Logout is idempotent for a validly
formatted refresh token, including one already rotated or revoked.

Passwords use Node's asynchronous scrypt with N=32768, r=8, p=3, random salts,
and parameters stored in the hash format. These parameters follow one of the
[OWASP scrypt configurations](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
Reset passwords currently require
12-256 characters; final product policy remains open. Single-use reset tokens
expire after 30 minutes. A reset revokes all sessions and remaining reset tokens.

## Password recovery and SMTP

Set `SMTP_HOST`, `SMTP_FROM`, and `PASSWORD_RESET_URL` together. Optional
`SMTP_USER`/`SMTP_PASSWORD` must be set as a pair. `SMTP_PORT` defaults to 587;
465 uses implicit TLS. Production requires a HTTPS reset URL and SMTP TLS.

The reset URL receives a `token` query parameter; the client/web page must submit
it with the new password to `/auth/reset-password`. No reset frontend is included.
Without mail configuration, forgot-password returns `503` for every identifier.
With configuration, known/unknown accounts receive the same generic response.
SMTP delivery runs asynchronously so its latency does not reveal account existence.
Delivery failures are logged without credentials or tokens; they do not change
the public response. Delivery is best-effort within this process; a durable email
queue remains a deployment choice. Live delivery needs the selected SMTP provider configured.

## Media storage

Uploads are stored privately under `MEDIA_DIRECTORY` (default `.data/media`),
outside static serving and source control. Keep this directory on persistent
storage. This initial adapter uses local disk; it is not a managed cloud-storage
integration. Multiple application replicas need a shared/provider-backed adapter.

- Input: JPEG, PNG, WebP up to 10 MB; MP4 up to 100 MB.
- Images are decoded, auto-oriented, and re-encoded to WebP; image metadata is
  stripped. Images are limited to 40 million decoded pixels.
- MP4 files are probed with the packaged ffprobe binary; dimensions and duration
  are server-verified. External network protocols are disabled during probing.
- Processing is synchronous for now. No transcoding or generated video thumbnail
  pipeline is included. Codec compatibility with the mobile client remains open.
- Upload requests currently use bounded in-memory buffering. Size/concurrency
  limits need tuning before production; large-scale uploads need a streaming adapter.
- Unattached uploads are private. Guests can download only while a published post
  or current profile references the asset. Downloads re-check access on every
  request, including HEAD/range requests; no public directory URL is exposed.
- Media file responses permit cross-origin rendering so the separate frontend
  origin can display published images/videos. Authorization/publication checks
  still execute before any file bytes are sent.
- Attachment/reference counts, post updates, and audit events commit in
  one transaction. Deletion atomically claims unreferenced media, preventing a
  concurrent attachment from leaving a dangling reference.
- Processing failures are marked `failed` and their files removed. Admins can
  delete unused assets. Automated orphan cleanup/retention is not yet configured.

## Settings and configuration

Guest language, autoplay, and notification preferences stay on the device.
`/app-info` exposes configured About text, contact email, Privacy Policy URL, and
supported languages. Optional unset values are `null` or an empty language list;
no languages or contact details are invented.

Default in-process, IP-based limits: 300 API requests/minute; 30 auth requests per
15 minutes; 30 uploads per 15 minutes. Configure `TRUST_PROXY_HOPS` for the actual
trusted reverse proxy. Multiple replicas require a shared rate-limit store.
Health endpoints are not subject to the API limiter.

## Verification and build

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

Tests use a real temporary MongoDB 8.0.17 one-member replica set, not mocked database
methods. On first use, `mongodb-memory-server` downloads the platform binary;
internet access is needed. Tests create/dispose their own database and private
temporary media directory. No running database or production credentials are used.

The build outputs `dist/`. Production needs a MongoDB replica set, persistent media
storage, HTTPS at the reverse proxy, suitable rate limits, and the agreed admin
provisioning method. This version has no production deployment configured.
