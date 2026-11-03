# Groupe Scout des Apôtres - Backend specification

Status: reviewed draft with an initial implementation in this repository.
Date: 2026-11-02
Last updated: 2026-11-03
Backend repository: https://github.com/selimellieh72/scoutapotresapp_backend
Client: React Native, with an X / Twitter-style interface.

## 1. Scope and decision status

### Confirmed by the user

- Backend: Express with MongoDB.
- The app serves one Scout group, Groupe Scout des Apôtres, with several admins.
- Guests can see posts without an account. This supersedes the earlier
  interpretation that reading requires login.
- Admin accounts can create posts.
- Keep one editable `groupProfile` document for the group's name, description,
  logo, and cover, with a singleton key preventing a second profile.
- No likes, comments, reposts, following, or direct messages (explicitly confirmed
  on 2026-11-03). Exclude their controls, counters, endpoints, and collections.
- Account creation is an open decision and must be called out as such.
- The entire competition module is excluded from this first draft.

### Proposed design in this draft

The API contracts, collections, limits, and technical behavior below are proposed
implementation details for review, unless identified as confirmed above or
carried over from the requirements PDF. They are not additional user decisions.

- Guests can browse the feed, post details, group profile, search, and published
  media. Admins have the same read access plus publishing and management rights.
- All active admins can edit/delete any post and update the single group profile.
- Posts publish immediately; the mobile client handles the pre-publication preview.
- Feed ordering is newest published first. No ranking algorithm is required.
- There are no reader accounts in the initial API design. If introduced later,
  their registration, permissions, and preferences need a separate decision.

### Included

Admin authentication and sessions; the public feed and post details; category and
content filters; admin post creation, editing, and deletion; image/video uploads;
one group profile; search/discover; app information and settings support.

### Outside this draft

- Competition: no competition entities, endpoints, voting, submissions, or results.
- Account creation/provisioning: no public signup or admin invitation API is
  specified yet. The PDF disallows public group registration; no public admin
  registration is proposed.
- Separate profiles or management for multiple Scout groups.
- Likes, comments, reposts, following, and direct messages are explicitly excluded
  from the app. The X / Twitter reference describes the visual direction only.
- A dedicated vertical-video feed, which the PDF labels optional.
- Push notification delivery and persistent server-side draft posts.

## 2. Permissions

| Capability | Guest | Active admin |
| --- | --- | --- |
| Read published posts and associated media | Yes | Yes |
| Search published content and view the group profile | Yes | Yes |
| Read app information | Yes | Yes |
| Upload media | No | Yes |
| Create, edit, delete posts | No | Yes |
| Update group name, description, logo, cover | No | Yes |
| View own admin account and end own sessions | No | Yes |
| Create accounts or grant admin access | Not defined | Not defined |

The backend enforces permissions on every protected request. Hiding controls in
the React Native app does not grant or enforce access. Disabled accounts cannot
perform admin actions or refresh sessions. Public responses never expose admin
email addresses, password hashes, session tokens, or internal audit records.

## 3. API conventions

- Base path: `/api/v1`. JSON request/response bodies except multipart file uploads.
- MongoDB IDs are exposed as string `id` fields. Dates use UTC ISO 8601 strings.
- Public read endpoints work without an Authorization header. An invalid token
  supplied by a client returns `401`; the client may retry public reads as a guest.
- Protected endpoints require `Authorization: Bearer <accessToken>` and an
  active admin account. No request body may assign roles or account ownership.
- Singular resources return `{ "data": { ... } }`. Lists return
  `{ "data": [ ... ], "page": { "nextCursor": null, "hasMore": false } }`.
- Default list limit: 20; maximum: 100. Reject invalid limits and cursors.
- Feed pagination sorts by `publishedAt DESC, id DESC`. The opaque cursor
  includes both sort keys; filters remain constant while paging.
- Use `201` for creation, `200` for reads/updates, and `204` for successful deletes
  and logout. Error responses have one stable envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "One or more fields are invalid.",
    "fields": { "category": "Choose a supported category." },
    "requestId": "request-id"
  }
}
```

Use `400` for invalid input, `401` for missing/invalid authentication on protected
routes, `403` for insufficient permission, `404` for unavailable resources, `409`
for state conflicts, `413` for oversized uploads, `415` for unsupported media,
`429` for rate limits, and `500` for unexpected errors. Do not expose stack traces.

## 4. Admin authentication and account creation boundary

Account creation is intentionally unresolved. Login/session behavior can be
specified independently, but an agreed provisioning/bootstrap process is a
prerequisite for a usable deployed backend. Do not silently add public signup,
shared default credentials, invitations, or a new privileged role.

Proposed authentication behavior:

- Login accepts an email address or username plus password. Normalize identifier
  lookup consistently; store only a salted password hash.
- Return a short-lived access token, refresh token, access expiry, and safe admin
  profile. Proposed lifetimes: 15-minute access, 30-day maximum session lifetime.
- Store refresh tokens as hashes, rotate on refresh, and revoke the session on
  detected reuse. Concurrent refresh behavior must avoid issuing two valid successors.
- Logout revokes the session immediately. Access-token validation must honor
  session revocation and disabled accounts rather than waiting for token expiry.
- Password reset uses a random, expiring, single-use token, stored as a hash.
  A successful reset revokes existing sessions. Proposed reset expiry: 30 minutes.
- Forgot-password responses are identical for known and unknown identifiers.
- Apply rate limits to login, reset, refresh, and uploads. Final thresholds and
  token/password libraries remain implementation decisions.
- The mobile client stores tokens in platform secure storage and clears them
  on logout. Refresh tokens are sent only to the refresh/logout endpoints.

| Method | Endpoint | Access | Contract |
| --- | --- | --- | --- |
| POST | `/auth/login` | Public | `{ identifier, password }` -> tokens and safe admin profile |
| POST | `/auth/refresh` | Refresh token | `{ refreshToken }` -> rotated token pair |
| POST | `/auth/logout` | Refresh token | Revoke its session; repeated logout is safe |
| POST | `/auth/forgot-password` | Public | `{ identifier }` -> generic acknowledgement |
| POST | `/auth/reset-password` | Reset token | `{ token, password }` -> reset and revoke sessions |
| GET | `/me` | Admin | Own `id`, display name, role, account status, email/username |

Email delivery provider, reset-link app routing, password policy, and admin
provisioning must be settled before authentication is considered release-ready.

## 5. Posts, feed, and sharing

Each post belongs to the single group, not to the admin as a public publishing
identity. Public responses show the group name/logo, publication date, category,
optional title, full text, and ordered media. Keep admin attribution internally.

Categories carried over from the PDF:

| API value | Display label |
| --- | --- |
| `article` | Article |
| `atelier` | Atelier |
| `installation` | Installation |
| `jeux` | Jeux |

- A post requires a valid category and either nonblank text or at least one ready
  media asset. An optional title alone does not constitute a post.
- Proposed limits: title 200 characters; text 20,000 characters; 10 media assets
  per post. Support text-only, image-only, video-only, and mixed content.
- Text is plain text in this draft. Do not accept executable HTML.
- Creation publishes immediately and sets `publishedAt` on the server. Editing
  retains that timestamp, updates `updatedAt`, and does not move the post to the top.
- Only ready assets uploaded by an active admin may be attached. Verify access
  and asset state on the server; do not accept arbitrary client storage URLs.
- Proposed deletion is soft deletion. Deleted posts disappear from feed, detail,
  search, and group queries. Referenced media access follows section 7.
- Search and filtering operate only on published, nondeleted content.
- Sharing uses a stable app/web post link. No tracking endpoint or share counter
  is required. The eventual link domain and deep-link routing remain open.

| Method | Endpoint | Access | Contract |
| --- | --- | --- | --- |
| GET | `/posts` | Public | Feed with `category`, `contentType`, `cursor`, `limit` |
| GET | `/posts/:postId` | Public | Full published post or `404` |
| POST | `/posts` | Admin | `{ category, title?, text?, mediaIds? }` -> published post |
| PATCH | `/posts/:postId` | Admin | Allowed content fields; revalidate the resulting post |
| DELETE | `/posts/:postId` | Admin | Remove from all public reads |

`contentType` accepts `text`, `image`, or `video`. `text` matches posts with no
media; `image`/`video` match posts containing at least one asset of that type. A
mixed-media post can match both image and video filters. `mediaIds` order controls
display order; a supplied array on PATCH replaces the complete attachment list.
Category and content filters combine with AND.

Example post response:

```json
{
  "data": {
    "id": "post-id",
    "group": { "id": "group-id", "name": "Groupe Scout des Apôtres", "logo": null },
    "category": "atelier",
    "title": "Atelier du samedi",
    "text": "Retour sur notre atelier.",
    "media": [],
    "publishedAt": "2026-11-02T12:00:00.000Z",
    "updatedAt": "2026-11-02T12:00:00.000Z"
  }
}
```

## 6. Group profile and search/discover

The app has exactly one group profile: name, short description, logo, and cover.
There is no group directory management, group creation API, or tenant membership
model. The Posts tab uses `/posts`; the Videos tab uses `/posts?contentType=video`.

| Method | Endpoint | Access | Contract |
| --- | --- | --- | --- |
| GET | `/group` | Public | Single group profile |
| PATCH | `/group` | Admin | `{ name?, description?, logoMediaId?, coverMediaId? }` |
| GET | `/search` | Public | `q`, optional category/content type/cursor/limit |
| GET | `/discover` | Public | Recent posts plus the group profile |

Group image fields accept ready image assets; explicit `null` clears the image.
Proposed limits: group name 120 characters, description 2,000 characters.

Search matches post titles/text and the group name/description. Return separate
`groups` and `posts` collections, with pagination metadata for posts; groups has
zero or one result. Category/content filters affect posts, not the group match.
Use newest-first order for matching posts initially. Proposed query length: 2 to
200 characters. Escape/validate queries; do not evaluate user-supplied database
operators or arbitrary regular expressions. Search language support remains open.

Discover returns recent published posts with cursor pagination and the singleton
group. Suggested content initially means recent content, not personalization.

## 7. Media lifecycle

MongoDB stores metadata and references; a media-storage adapter stores binary
files. The storage provider, deployment region, and processing service are open
decisions. Do not couple the public API to a specific vendor's object keys.

| Method | Endpoint | Access | Contract |
| --- | --- | --- | --- |
| POST | `/media` | Admin | Multipart `file` -> asset metadata and processing state |
| GET | `/media/:mediaId` | Public if published; otherwise admin | Metadata and authorized delivery URL |
| DELETE | `/media/:mediaId` | Admin | Delete unattached asset; `409` if referenced |

- Proposed accepted inputs: JPEG, PNG, WebP images; MP4 video. Proposed maximums:
  10 MB per image and 100 MB per video. Supported codecs/durations remain open.
- Validate actual file type and size, not just extension/client MIME type. Use
  generated storage keys and do not fetch arbitrary URLs supplied by clients.
- An asset is `processing`, `ready`, or `failed`; only `ready` assets can publish.
  Image dimensions and video duration are server-verified. Include thumbnails
  when supported; a full transcoding pipeline is not assumed in the draft.
- Guest access is allowed only while the asset is referenced by at least one
  published post or the current public group profile. Unattached uploads and
  deleted-only assets must not become public by guessing an ID.
- Deliver via controlled access or short-lived URLs. Removing the last public
  reference prevents new public URLs; existing signed URLs may work until expiry.
  Immediate revocation and any CDN cache policy must be agreed if required.
- Do not delete a file that is still used elsewhere. Failed uploads and orphaned
  assets require cleanup; retention periods remain open.
- API asset DTOs include `id`, `type`, `mimeType`, `sizeBytes`, dimensions,
  `durationSeconds` for video, processing state, and authorized URLs where allowed.

## 8. Settings and app information

Guests have no server-side user profile. Language selection, video autoplay, and
notification preferences are device-local for this version. Do not require an
account simply to retain these settings. Supported languages remain undecided.

`GET /app-info` is public and returns About text, contact details, privacy-policy
URL, and supported languages once selected. Administrators' account information
comes from `/me`. Login/logout use the authentication endpoints. Push delivery,
device registration, and preferences synced across devices are outside this draft.

## 9. Proposed MongoDB collections

All mutable documents have `createdAt` and `updatedAt` timestamps.

| Collection | Main fields | Constraints/indexes |
| --- | --- | --- |
| `admins` | normalized email/username, display name, password hash, status, role fixed to admin | Unique normalized identifiers; optional usernames use an index that excludes missing values |
| `sessions` | adminId, refreshTokenHash, token-family/reuse metadata, expiresAt, revokedAt | Unique token hashes; expiry cleanup; adminId lookup |
| `passwordResetTokens` | adminId, tokenHash, expiresAt, consumedAt | Unique token hash; expiry cleanup |
| `groupProfile` | fixed singleton key, name, description, logoMediaId, coverMediaId | Unique singleton key prevents a second profile |
| `posts` | category, title, text, ordered mediaIds, createdByAdminId, updatedByAdminId, publishedAt, deletedAt | Feed indexes on publishedAt/id, plus category/deletion filtering; search index chosen after language decision |
| `media` | uploadedByAdminId, storageKey, type, MIME, size, dimensions, duration, state | Unique storageKey; uploader/state/createdAt for cleanup |
| `auditEvents` | actorAdminId, action, targetType, targetId, timestamp, requestId | Target/time and actor/time lookups; no secrets or raw credentials |

Only admin records are modeled initially; future reader accounts are not silently
added. Audit records cover publishing, edits, deletes, and group profile changes.
App-information content may be configuration rather than a database collection.

Database indexes must enforce uniqueness, rather than relying only on a
check-before-insert request handler. Expiring records must also be checked against
the server clock on use; background cleanup is not an authorization check.

## 10. Implementation and operational expectations

- Start with one Express service and MongoDB. The first implementation uses
  TypeScript and the official MongoDB driver as implementation defaults; these
  are not additional user-mandated technology requirements.
- Separate routes, validation, authentication/authorization, application logic,
  database access, and email/media adapters. Avoid microservices in the first version.
- Validate allowed input fields, IDs, enums, lengths, and pagination. Prevent
  mass assignment and injection by mapping validated fields explicitly.
- Use HTTPS in production, security headers, explicit request/upload limits,
  restricted browser origins where relevant, and rate limiting. CORS is not
  an authentication mechanism.
- Configure secrets and provider credentials outside source control. Logs contain
  request IDs and operational events, never passwords, reset tokens, or session tokens.
- Provide `GET /health` for liveness and `GET /ready` for database readiness;
  neither returns secrets or detailed infrastructure information.
- Include `.env.example` without secrets, local setup instructions, database index
  initialization, and documented media/email configuration when implementation begins.
- Hosting, backups/restore, retention, monitoring, and performance targets remain
  deployment decisions. No production-ready performance claim is made by this draft.

## 11. Acceptance criteria for the eventual implementation

1. A guest can read the feed, post details, group profile, search, and discover
   without a token; only published content is returned.
2. A guest cannot upload media, publish/edit/delete posts, or update the group.
3. An active admin can log in, refresh a session, publish/edit/delete a valid post,
   update the profile, and log out. Logout/reset/disable prevent protected access.
4. All four categories and text/image/video/mixed posts work. Empty posts, invalid
   categories, invalid media references, and over-limit inputs are rejected.
5. Published posts carry the group identity, accurate timestamps, and ordered media;
   public responses do not expose admin credentials or private account details.
6. Pagination has no repeated posts when several posts share a publication timestamp;
   category/content filters and search exclude deleted posts.
7. Pre-publication uploads are private. Unpublished media cannot be attached unless
   ready; deleting a reference cannot remove an asset still used by another post.
8. Password resets are single-use and expiring; authentication errors do not reveal
   whether an account exists. Refresh replay and disabled-account access are tested.
9. Duplicate admin identifiers and duplicate group profiles fail at the database
   boundary, including simultaneous requests.
10. The delivered API contains no competition endpoints or account-creation flow
    presented as agreed behavior.

11. No like/reaction, comment, repost, following, or direct-message endpoints,
    collections, or response counters are included. The client has no controls
    for these features. External link sharing remains supported as specified
    in section 5; it does not create an in-app repost.

These are acceptance targets. See `README.md` for the implementation,
verification commands, configuration requirements, and current limitations.

## 12. Open decisions

| Decision | Current status / consequence |
| --- | --- |
| Admin account creation and first-admin provisioning | Explicitly open; needed before real admins can use login |
| Reader accounts | No reader account needed for public browsing; any later creation flow remains open |
| JavaScript vs TypeScript; driver vs ODM | Initial implementation uses TypeScript and the official MongoDB driver |
| Media storage, delivery, codecs, final limits, cleanup | Select before upload implementation |
| Email provider and password/reset policy | Select before authentication release |
| Languages and search language behavior | Select before localization/search tuning |
| Share domain and app links | Select before end-to-end sharing |
| Deployment, retention, monitoring, performance targets | Select before production release |
| Dedicated vertical-video feed and push notifications | Deferred; separate scope decision |

## 13. References and precedence

- Direct user clarifications, 2026-11-03: the app must have no likes, comments,
  reposts, following, or direct messages.
- Direct user clarifications in this chat, 2026-11-02, take precedence over older
  interpretations and conflicting PDF requirements. In particular: one group,
  public guest reading, admin publishing, account creation open, competition excluded.
- Saved project context supplied with this project; current decisions are summarized above.
- Original UI/UX requirements PDF supplied by the user. The
  multi-group and competition portions are not adopted into this first draft.
- [Backend repository](https://github.com/selimellieh72/scoutapotresapp_backend):
  inspected again on 2026-11-03; GitHub reported it empty before the first local
  implementation was created in `backend/`.
- [Express production security guidance](https://expressjs.com/en/advanced/best-practice-security/)
  supports the HTTPS, input-validation, security-header, and authentication-protection proposals.
- [MongoDB compound unique indexes](https://www.mongodb.com/docs/manual/core/index-unique/create-compound/)
  documents database-enforced uniqueness across combinations of fields.

## 14. Initial implementation notes (2026-11-03)

- Implemented locally in the backend repository checkout at `backend/`, on branch
  `codex/backend-core`. Implementation authorization came from the user's request
  to start implementing; public account creation remains undecided and absent.
- Express 5, TypeScript, and the official MongoDB driver. Writes involving media
  references, publishing, audit records, or password reset use transactions and
  require a replica set. A local MongoDB Compose configuration is provided.
- Random opaque access/refresh tokens, hashed server-side, implement the session
  contract. Access tokens rotate on refresh. Clients must serialize refresh calls;
  replay or simultaneous reuse revokes the session. No JWT dependency is used.
- Uploads use private local disk and controlled downloads that check publication
  on each request. Images are decoded/re-encoded to WebP; MP4 metadata is probed.
  Production storage, video codec policy, streaming uploads at scale, and automatic
  orphan cleanup remain open. Transcoding/video thumbnails are not implemented.
- SMTP is configurable. Without email configuration, forgot-password returns
  `503` consistently for every identifier. Live email delivery needs provider setup.
- Initial password-reset policy is 12-256 characters. Password hashes use scrypt
  N=32768, r=8, p=3. Final product password policy remains open.
- Search currently uses escaped, case-insensitive literal matching with bounded
  queries. Production search tuning and supported languages remain open.
- There is no account bootstrap command or default admin. Tests use disposable
  admin fixtures; the agreed real account-provisioning flow is still required.
