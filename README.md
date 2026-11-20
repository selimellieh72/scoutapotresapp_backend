# Scout Apôtres API

Express, MongoDB, and local media storage for the Scout Apôtres app.

## Account and publishing model

- A group is an account. There are no child admin accounts and no public signup.
- Group accounts are created from a seed file and log in with their own username/password.
- Every published post appears in the same public feed, regardless of its group.
- A group profile is public identity information only; it is not a separate feed.
- An authenticated group can edit only its own profile, posts, and unpublished media.
- A post may contain text with zero or one image. Video and multiple attachments are rejected.

## Local setup

Use Node 24 and pnpm 11.

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev
```

MongoDB must run as a replica set because content and media-reference writes use transactions.

Run all checks with:

```sh
pnpm check
```

## Seed group accounts

Build the project, copy `ops/groups.seed.example.json`, and enter the real groups and credentials. The seed command rejects duplicate identifiers and never overwrites an existing account.

```sh
pnpm build
pnpm seed:groups /absolute/path/to/groups.json
```

Seed files contain plaintext passwords and must not be committed. Passwords are hashed before insertion.

## Migrate the legacy admin model

Before deploying this schema over a database created by the earlier single-group/admin version, run:

```sh
pnpm migrate:group-accounts
```

The migration preserves account IDs, password hashes, real post ownership, sessions, reset tokens, media ownership, and audit attribution. It copies each legacy admin into a group account, archives orphaned posts only when they are explicitly labeled demo content, and retains the legacy collections for rollback. It performs ownership and conflict checks before starting its transaction and is safe to rerun.

## Main API routes

All routes are under `/api/v1`.

| Method | Route | Access | Purpose |
|---|---|---|---|
| `POST` | `/auth/login` | Public | Log in as a seeded group account |
| `POST` | `/auth/refresh` | Public | Rotate a session |
| `POST` | `/auth/logout` | Group | End the current session |
| `GET` | `/me` | Group | Return the current group account |
| `GET` | `/posts` | Public | Read the global feed |
| `GET` | `/posts/:postId` | Public | Read one post |
| `GET` | `/me/posts` | Group | Manage the current group's posts |
| `POST` | `/posts` | Group | Publish to the global feed |
| `PATCH` | `/posts/:postId` | Owning group | Update a post |
| `DELETE` | `/posts/:postId` | Owning group | Delete a post |
| `GET` | `/groups` | Public | List public group profiles |
| `GET` | `/groups/:groupId` | Public | Read a public group profile |
| `PATCH` | `/me/group` | Group | Update the current group's profile |
| `POST` | `/media` | Group | Upload one media file |
| `DELETE` | `/media/:mediaId` | Owning group | Delete an unreferenced upload |
| `GET` | `/search` | Public | Search the global feed and profiles |
| `GET` | `/discover` | Public | Return global posts and group profiles |

All public post responses include the publishing group's public ID, name, and logo. Private credentials and internal attribution are never returned.

## Production

Deployment details are documented in `ops/README.md`. Production secrets belong only in the server environment. Do not commit `.env` files or account seed files.
