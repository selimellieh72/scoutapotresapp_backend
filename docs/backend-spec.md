# Backend behavior specification

## Identity

Each scout group is one seeded account. A group account contains private login fields (`email`, `username`, password hash, status, auth version) and public profile fields (`name`, `description`, logo, cover). The service has no public registration, roles, or nested administrator accounts.

Public profile reads never expose login identifiers or credential data. Authenticated `/me` responses expose only the current account's safe fields.

## Publishing

There is one public feed. `GET /posts` combines posts from every active group and orders them by publication time and ID. A group profile does not own a public sub-feed.

An authenticated group may:

- create a post in the global feed;
- list its own posts through `/me/posts` for management;
- update or delete only posts whose `groupId` is its own ID;
- update only its own public profile;
- attach only media it uploaded.

A post supports text with zero or one ready image. It must contain text or an image. Videos and multiple attachments are invalid. The returned post embeds the publishing group's public identity.

## Sessions and recovery

Access and refresh tokens are random values stored only as hashes. Refresh rotates both tokens. Sessions and password-reset records reference `groupId`; password reset increments `authVersion` and revokes existing sessions.

## Media

Uploads are initially private to their owning group. A ready asset becomes publicly readable when referenced by a public post or public profile. Reference counts are updated in the same transaction as content. Owners may delete only unreferenced assets.

## Persistence

Primary collections are `groups`, `sessions`, `passwordResetTokens`, `posts`, `media`, and `auditEvents`. Posts, media, sessions, reset records, and audit events reference the owning/acting group directly. MongoDB must support transactions.

## Provisioning and migration

`pnpm seed:groups /absolute/path/to/groups.json` creates new group accounts from an offline seed file. The command validates the whole file before writing and refuses identifier conflicts.

`pnpm migrate:group-accounts` upgrades the earlier admin-based data model while preserving IDs, password hashes, ownership, and sessions. It must be run before the new application version starts against a legacy database.

## Acceptance criteria

1. Two groups can log in using their own seeded credentials.
2. Posts from both groups appear in the same unauthenticated `/posts` response.
3. A group cannot update, delete, or attach another group's content or media.
4. Group profile routes return identity only and do not expose a separate feed.
5. Text-only and one-image posts succeed; multiple-image and video posts fail.
6. Search and discovery cover the global feed and all active group profiles.
7. No endpoint creates a public account or a nested administrator.
