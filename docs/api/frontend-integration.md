# CiviCon API — frontend integration guide

Everything the web/mobile client needs to talk to this backend. Every route, field,
rule and error below was read off the code, not from memory. Where the API will
surprise you, it says so.

- Base URL (local): `http://localhost:9000`
- No global route prefix. `/auth/login`, not `/api/auth/login`.
- Everything is JSON except file upload (multipart) and file download (bytes).
- Dates come back as ISO-8601 strings (`"2026-09-18T10:22:41.512Z"`).
- Ids are Mongo ObjectId strings (24 hex characters).

---

## 0. Read this before you start

Three things will cost you a day each if you find them the hard way.

**1. CORS is not enabled yet — this is a blocker.** The server never calls
`enableCors()`, so every browser request from `http://localhost:5173` (or any
other origin) fails at the preflight. Nothing in this guide works from a browser
until the backend adds it. Ask the backend team to enable CORS for your dev
origin and your deployed origin. Postman and curl are unaffected, so you can
explore the API today — you just can't ship a page against it.

**2. The token carries the roles it was issued with.** If an admin grants someone
AGENCY, their existing token still says CITIZEN until they log in again.
`GET /auth/me` reads the database and will show the new roles, so the two can
disagree. Treat a 403 on an action the UI thought was allowed as "your session
is stale — sign in again".

**3. List endpoints return an array, not a page object.** There's no total count,
so you cannot render "page 3 of 12". Use `limit` and `offset` with a
"Load more" button, and stop when you get back fewer items than you asked for.

---

## 1. Authentication

A JSON Web Token in the `Authorization` header. Nothing else — no cookies, no
refresh token, no logout endpoint.

```
Authorization: Bearer <token>
```

Tokens last **7 days** by default and there is **no refresh flow**. When one
expires the user signs in again. Store it wherever your framework prefers;
`localStorage` is fine for the demo, and a real deployment should revisit it.

Routes are protected by default. The only routes reachable without a token are
the ones marked **public** in this guide: browsing issues, reading an issue,
listing its media, and downloading a file.

### POST /auth/register — public

Always creates a **CITIZEN**. There is no `roles` field, and sending one is a 400
(see "Unknown fields" below). AGENCY, SPONSOR and ADMIN accounts are made by an
admin or the seed.

```json
{ "name": "Ama Mensah", "email": "ama@example.com", "password": "Password123!" }
```

| Field | Rules |
|---|---|
| `name` | required, non-empty string |
| `email` | required, valid email, stored lowercase |
| `password` | required, 8–72 characters (bcrypt truncates past 72, so longer is refused rather than silently cut) |

**201** → `{ "token": "...", "user": PublicUser }`
**400** validation · **409** email already registered

### POST /auth/login — public

```json
{ "email": "ama@example.com", "password": "Password123!" }
```

**200** → `{ "token": "...", "user": PublicUser }` (200, not 201 — nothing is created)
**401** `"Invalid credentials"`

That one message covers every failure: unknown email, wrong password, and a
deactivated account. That's deliberate — anything more specific would let someone
test whether an address is registered. **Don't try to tell the user which it was.**

### GET /auth/me

Returns the current `PublicUser`, read fresh from the database. Use it on app
boot to confirm the stored token is still valid (401 → send them to sign-in) and
to pick up role changes.

### PublicUser

```ts
{
  id: string
  name: string
  email: string
  roles: Role[]            // an ARRAY — a user can hold several
  civicPointsCached: number
  reputation: number       // always 100 today; nothing changes it yet
}
```

`roles` being an array matters: check `user.roles.includes('AGENCY')`, never
`user.role === 'AGENCY'`.

---

## 2. Errors

Two shapes. Both always carry `statusCode`, `message` and `error`.

**Validation failures** put a list in `message`:

```json
{
  "statusCode": 400,
  "message": ["password must be longer than or equal to 8 characters"],
  "error": "Bad Request"
}
```

**Everything else** puts a sentence in `message`:

```json
{ "statusCode": 409, "message": "This issue is already claimed by another volunteer", "error": "Conflict" }
```

So a helper that renders errors must handle both:

```ts
const text = Array.isArray(body.message) ? body.message.join('\n') : body.message;
```

The sentences are written to be shown to users. You can display them directly.

### Status codes and what they mean here

| Code | Meaning in this API |
|---|---|
| 400 | The body is malformed, or a required companion field is missing (a reason, a `duplicateOf`) |
| 401 | No token, expired token, or bad credentials |
| 403 | You're authenticated, but this isn't yours to do (wrong role, not the reporter, not the holder) |
| 404 | No such issue / user / file |
| 409 | The action conflicts with the issue's current state (already claimed, wrong status for this move, duplicate email) |
| 413 | The uploaded file is over its size cap |
| 415 | The uploaded file's type isn't accepted |
| 416 | A `Range` header asked for bytes outside the file |

**409 is the one to design for.** Two people clicking "Claim" on the same issue is
normal, not exceptional — one of them gets a 409 and your UI should refresh the
issue rather than show a scary error.

### Unknown fields are rejected

The server strips nothing and forgives nothing: any property not in the expected
body gives a **400**, naming the offending field.

```json
{ "statusCode": 400, "message": ["property roles should not exist"], "error": "Bad Request" }
```

This bites when you `PATCH` an object you got from a `GET`. Send only the fields
you're changing — never spread the whole issue back.

---

## 3. Enumerations

Hardcode these; they're stable server contracts.

```ts
type Role = 'CITIZEN' | 'AGENCY' | 'SPONSOR' | 'ADMIN';

type IssueCategory =
  | 'SANITATION' | 'ROADS' | 'WATER' | 'ELECTRICITY'
  | 'DRAINAGE' | 'PUBLIC_SAFETY' | 'OTHER';

type IssueStatus =
  | 'OPEN'        // reported, nobody has taken it
  | 'CLAIMED'     // a volunteer holds it
  | 'IN_PROGRESS' // work has started
  | 'RESOLVED'    // proof submitted, waiting on review
  | 'AI_APPROVED' // the AI believes it's fixed; an agency must confirm
  | 'VERIFIED'    // confirmed by an agency — points paid
  | 'REJECTED'    // closed, not a real issue
  | 'DUPLICATE';  // closed, points at another issue

type AiOutcome =
  | 'APPROVED'           // confident it's fixed
  | 'BELOW_THRESHOLD'    // assessed, not confident enough
  | 'SKIPPED_NO_BEFORE'  // no original photo to compare against
  | 'FAILED';            // the AI call errored or timed out

type PointsReason = 'RESOLUTION_VERIFIED' | 'VERIFICATION_REVERSED';
```

Category is **required** when reporting. The backend knows people don't always
know the category; making it optional is planned but not built.

---

## 4. Issues

### The Issue object

Every issue endpoint returns this exact shape. Optional fields are absent (not
`null`) when they don't apply.

```ts
{
  id: string
  title: string
  description: string
  category: IssueCategory
  location: string            // free text, e.g. "Market Street junction"
  status: IssueStatus
  reportedBy: string          // user id
  media: Media[]              // [] on create; see §5

  statusReason?: string       // why an agency rejected / overruled
  duplicateOf?: string        // issue id, when status is DUPLICATE
  volunteerId?: string        // who holds it
  claimedAt?: string
  resolutionNote?: string     // what the volunteer says they did
  resolvedAt?: string
  verifiedAt?: string
  aiAssessment?: AiAssessment // see §6

  createdAt: string
  updatedAt: string
}
```

There are no user names on an issue — only `reportedBy` and `volunteerId` ids. To
show "Reported by Ama" you need a separate lookup, and there is **no public
endpoint for another user's profile** (`GET /users/:id` is admin-only). For now,
show ids, show "you" when it matches the signed-in user, or ask the backend for
an embedded name.

### GET /issues — public

The main feed. Newest first.

| Query | Values |
|---|---|
| `status` | any `IssueStatus` |
| `category` | any `IssueCategory` |
| `reportedBy` | user id |
| `volunteerId` | user id |
| `aiOutcome` | any `AiOutcome` |
| `limit` | 1–100, **default 20** |
| `offset` | 0 or more, default 0 |

```
GET /issues?status=OPEN&category=SANITATION&limit=20&offset=0
```

Returns `Issue[]`, each with its media already attached — one round trip for a
feed with thumbnails.

Useful queries for your screens:
- Open issues to browse: `?status=OPEN`
- My reports: `?reportedBy=<my id>`
- My claimed work: `?volunteerId=<my id>`
- Agency inbox: `?status=AI_APPROVED` (AI says fixed, awaiting confirmation)
- Agency review queue: `?aiOutcome=BELOW_THRESHOLD`, `?aiOutcome=SKIPPED_NO_BEFORE`, `?aiOutcome=FAILED`

### GET /issues/:id — public

One `Issue`, media included. **404** if the id doesn't exist; **400** if it isn't a
valid ObjectId, so validate the shape before you navigate.

### POST /issues — CITIZEN

```json
{
  "title": "Blocked drain floods the junction",
  "description": "Standing water after every rain; the gutter is full of silt.",
  "category": "DRAINAGE",
  "location": "Market Street junction"
}
```

| Field | Rules |
|---|---|
| `title` | required, ≤ 140 characters |
| `description` | required, ≤ 2000 |
| `category` | required, one of the enum |
| `location` | required, ≤ 200 |

Don't send `status` or `reportedBy` — both are derived, and sending them is a 400.

**201** → the new `Issue` (status `OPEN`, `media: []`). Photos are a **second step**
(§5).

**403** if the account doesn't hold CITIZEN. An agency-only account cannot report.

### PATCH /issues/:id — the reporter, while OPEN

Same four fields, all optional. Send only what changed.

**403** you didn't report it (admins get 403 too — rewriting someone's account of
what they saw isn't an admin power)
**409** the issue has moved past OPEN and can no longer be edited

### The lifecycle

```
                  ┌── agency ──> REJECTED   (reason required)
                  ├── agency ──> DUPLICATE  (duplicateOf required)
  OPEN ──claim──> CLAIMED ──start──> IN_PROGRESS
    ^                │                    │
    │                └──── resolution ────┤
    │                                     v
    └── release / agency reopen ───── RESOLVED
                                          │
                       ┌── AI approves ───┤
                       v                  │
                  AI_APPROVED             │
                       │                  │
                 agency confirms    agency confirms
                       └────────┬─────────┘
                                v
                            VERIFIED  → +10 points to the volunteer
```

An agency can send `RESOLVED`, `AI_APPROVED` or `VERIFIED` back to `IN_PROGRESS`
with a reason. Undoing a `VERIFIED` also takes the 10 points back.

### Volunteer actions

These are separate routes on purpose — a client can never name a status it isn't
entitled to.

| Route | Who | Effect | Common errors |
|---|---|---|---|
| `POST /issues/:id/claim` | any CITIZEN except the reporter | OPEN → CLAIMED | **409** already claimed · **403** you reported it · **409** not OPEN |
| `DELETE /issues/:id/claim` | the holder | back to OPEN; clears `volunteerId`, `claimedAt`, `resolvedAt`, `resolutionNote` | **403** not the holder |
| `POST /issues/:id/start` | the holder | CLAIMED → IN_PROGRESS | **403** not the holder |
| `POST /issues/:id/resolution` | the holder | → RESOLVED (or AI_APPROVED) | **400** no proof photo · **403** not the holder |

All four return **200** with the updated `Issue` (not 201 — nothing is created).

`POST /issues/:id/resolution` takes `{ "note": "..." }` (required, ≤ 2000) and
**requires at least one proof photo uploaded by that same volunteer first**.
Photos left by a previous volunteer don't count. Your resolve screen must
therefore be: upload photo(s) → then submit the note. If you submit first you get:

```json
{ "statusCode": 400, "message": "Attach at least one photo as proof of work before resolving", "error": "Bad Request" }
```

This call is also where the AI runs, **synchronously** — it can take up to 60
seconds. Show a spinner that tolerates a slow response, and read the returned
`status` to see what happened.

The AI compares **at most 2 images per side**, taken in upload order: the first
two `REPORT` photos against the first two `PROOF` photos by this volunteer. So
the clearest shot should be uploaded first.

**A side with no photo falls back to its video** — two stills are pulled from it
(midpoint and near the end) and used as the images. Decoding adds up to 15
seconds, and only happens when that side has no photograph at all. A video
alongside a photo is ignored.

### PATCH /issues/:id/status — AGENCY or ADMIN

The agency's single control. Body:

```json
{ "status": "VERIFIED", "reason": "optional", "duplicateOf": "optional issue id" }
```

Only these targets are accepted; anything else is **403**:

| Target | Requires | Notes |
|---|---|---|
| `VERIFIED` | — | pays the volunteer 10 points |
| `IN_PROGRESS` | `reason` | sends work back; reverses points if it was VERIFIED |
| `OPEN` | `reason` (when someone holds it) | force-release |
| `REJECTED` | `reason` | not a real issue |
| `DUPLICATE` | `duplicateOf` | must exist, and can't be the issue itself |

`reason` is capped at **500 characters** — cap the textarea to match, or the
agency loses what they typed to a 400.

`RESOLVED`, `CLAIMED` and `AI_APPROVED` are **not** settable here — the first needs
evidence, the second needs a volunteer, the third belongs to the AI.

**What each move does to the issue's fields:**

- `IN_PROGRESS` (send back) clears `resolvedAt`, `resolutionNote` and
  `verifiedAt`, and the **same volunteer keeps the issue** — they're expected to
  try again. `aiAssessment` is deliberately **left in place**, so a sent-back
  issue still carries the old verdict. Don't render it as current: check
  `status` first, and only show the assessment on a `RESOLVED` or `AI_APPROVED`
  issue.
- `OPEN` (force-release) clears `volunteerId`, `claimedAt`, `resolvedAt` and
  `resolutionNote`. The issue is free for anyone to claim again.
- `statusReason` is **overwritten on every status change** — including with
  nothing when no `reason` is sent, as on `VERIFIED`. Never assume a
  `statusReason` you saw earlier is still there.

**A user cannot confirm their own work.** Someone holding both CITIZEN and AGENCY
who fixed the issue themselves gets:

```json
{ "statusCode": 403, "message": "You cannot verify work you did yourself", "error": "Forbidden" }
```

Hide the confirm button when `issue.volunteerId === currentUser.id`.

Other failures: **409** `"Cannot move an issue from X to Y"` (the issue moved
under you — refetch) · **400** a missing `reason` or `duplicateOf`.

---

## 5. Media

Photos and video live in the database (GridFS) and are served by the API. Upload
is always a **second step after the issue exists**.

### Limits

| | Types | Max size |
|---|---|---|
| Images | `image/jpeg`, `image/png`, `image/webp` | 5 MB |
| Video | `video/mp4`, `video/webm` | 50 MB |

**Five files per issue, total.** Validate type and size in the browser before
uploading — a rejected 50 MB video is a slow, expensive 413.

### POST /issues/:id/media — multipart

One file per request, in a field named exactly **`file`**.

```ts
const body = new FormData();
body.append('file', file);                     // the field name must be "file"
await fetch(`${BASE}/issues/${id}/media`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` }, // do NOT set Content-Type
  body,
});
```

Let the browser set `Content-Type` — if you set it yourself the multipart
boundary is lost and the server sees no file.

**Who may upload, and what the file counts as, is decided by the issue's status** —
the client doesn't choose:

| Issue status | Who may upload | Stored as |
|---|---|---|
| `OPEN` | the reporter only | `REPORT` (the "before" photo) |
| `CLAIMED` / `IN_PROGRESS` | the holding volunteer only | `PROOF` (the "after" photo) |
| anything else | nobody | **409** |

**201** → the `Media` object · **400** no file sent · **403** not yours to attach ·
**409** over 5 files, or the status forbids it · **413** too big · **415** wrong type

**Two different 413s, from two different places:**

| Case | Message | Where it comes from |
|---|---|---|
| An image between 5 MB and 50 MB | `A image may be at most 5242880 bytes` | The app, after the whole file has uploaded |
| Anything over 50 MB | `File too large` | The parser, which aborts mid-upload |

The first one means the user waited through a full upload before being told no —
the strongest reason to check `file.size` against the per-type cap in the browser
first.

Getting the field name wrong gives **400** `"Unexpected field - <name>"`. If you
see that, the `FormData` key isn't `file`.

### The Media object

```ts
{
  id: string
  filename: string
  contentType: string
  size: number              // bytes
  uploadedAt: string
  purpose: 'REPORT' | 'PROOF'
  url: string               // "/issues/media/<id>" — RELATIVE
}
```

`url` is relative. Prefix it with your base URL: `` `${BASE}${media.url}` ``.

### GET /issues/media/:mediaId — public

The bytes. Public and token-free, so it drops straight into a tag:

```html
<img src="http://localhost:9000/issues/media/652f..." />
<video src="http://localhost:9000/issues/media/652f..." controls></video>
```

Supports HTTP range requests, so video seeking and streaming work: the response
carries `Accept-Ranges: bytes`, and a `Range` request gets **206** with
`Content-Range`. A range beyond the end of the file is **416**. The browser
handles all of this for you in `<img>` and `<video>` — you only need it if you
fetch bytes yourself.

### GET /issues/:id/media — public

`Media[]` for one issue. You rarely need it — `GET /issues` and `GET /issues/:id`
already embed the media.

### DELETE /issues/media/:mediaId

**204**, no body. Same permission rule as upload: the reporter while OPEN, the
holder while CLAIMED/IN_PROGRESS.

---

## 6. AI proof verification

When a volunteer resolves an issue, the backend compares the "before" photos with
the "after" photos and writes an assessment onto the issue.

```ts
aiAssessment?: {
  outcome: AiOutcome
  confidence?: number   // 0–1; absent for SKIPPED_NO_BEFORE and FAILED
  reasoning?: string    // the model's explanation — show this to agencies
  model?: string
  assessedAt: string
}
```

What each outcome means for the UI:

The threshold is **0.7**: `fixed` at or above it gives `APPROVED`, anything else
gives `BELOW_THRESHOLD`. It's server-side configuration, so don't reimplement the
comparison — read `outcome`, and use `confidence` only for display.

| `outcome` | Resulting status | What to show |
|---|---|---|
| `APPROVED` | `AI_APPROVED` | "AI checked this — an agency will confirm shortly" |
| `BELOW_THRESHOLD` | `RESOLVED` | "Awaiting review" + the reasoning, for agencies |
| `SKIPPED_NO_BEFORE` | `RESOLVED` | "No original photo to compare — manual review" |
| `FAILED` | `RESOLVED` | "Automatic check unavailable — manual review" |

`FAILED` also covers proof that couldn't be read as an image — a corrupt or
undecodable video with no photo beside it. The API isn't called in that case.

**The AI never pays anyone.** `AI_APPROVED` is a recommendation; only an agency
moving the issue to `VERIFIED` awards points.

`aiAssessment` is **absent entirely when the feature is switched off** (no API key
configured). Then resolutions simply sit at `RESOLVED` waiting for a human. Your
UI must handle its absence — don't assume every resolved issue has one.

It can also be **stale**: an agency sending work back to `IN_PROGRESS` leaves the
old assessment on the issue on purpose (what the model said, and got wrong, is
worth keeping). Only treat it as current when `status` is `RESOLVED` or
`AI_APPROVED`; on an `IN_PROGRESS` issue it describes a previous attempt.

A volunteer who proves their work with **video alone is assessed on frames taken
from that video**, so video-only proof is a supported path — it just costs the
volunteer a few more seconds of waiting while the clip is decoded.

---

## 7. Civic points

A volunteer earns **10 points** when an agency confirms their work. If the agency
later undoes that, a **−10** entry is added; the original is never deleted, so the
history is always readable.

### GET /users/me/points

Your own balance only — there's no endpoint for another user's ledger.

```json
{
  "balance": 20,
  "transactions": [
    { "id": "...", "issueId": "...", "amount": 10, "reason": "RESOLUTION_VERIFIED",   "createdAt": "..." },
    { "id": "...", "issueId": "...", "amount": -10, "reason": "VERIFICATION_REVERSED", "createdAt": "..." }
  ]
}
```

The 20 most recent entries, newest first. `balance` is the true sum of the whole
ledger, not just of those 20.

**Which number to trust:** `user.civicPointsCached` (on `PublicUser`) is a cached
copy, and it can briefly lag right after a confirmation. It's fine for a header
badge. On a points screen, call this endpoint — it's always exact.

Points can't be spent on anything yet, and issues confirmed before points existed
carry no entries, so older volunteers legitimately show 0.

---

## 8. Admin endpoints — ADMIN only

Only needed if you build an admin console. All return **403** for everyone else.

| Route | Effect |
|---|---|
| `GET /users` | every user |
| `GET /users/:id` | one user |
| `PATCH /users/:id` | `{ name?, email?, isActive? }` |
| `PATCH /users/:id/roles` | `{ roles: Role[] }` — **replaces** the array; this is the only way AGENCY/SPONSOR/ADMIN accounts are made |
| `DELETE /users/:id` | **204** |

Careful: `roles` replaces, it doesn't add. To make an existing citizen an agency
too, send `["CITIZEN","AGENCY"]`, not `["AGENCY"]`.

These return the raw database document (with `_id`, `__v`), **not** the `PublicUser`
shape the auth routes return. The password hash is never included.

`PATCH /users/:id` with an email another account already has gives **409**, the
same as registration. There's no endpoint for changing a password.

---

## 9. Suggested screens

A build order that follows what the API actually supports.

1. **Sign up / sign in** → store the token, call `GET /auth/me` on boot.
2. **Issue feed** — `GET /issues?status=OPEN`, filter chips for category,
   "Load more" via `offset`. Public, so it works signed out.
3. **Report an issue** — form → `POST /issues` → then upload photos to the new id.
   Treat it as one wizard; the user shouldn't know it's two calls.
4. **Issue detail** — `GET /issues/:id`, media gallery, a status timeline built
   from `createdAt` / `claimedAt` / `resolvedAt` / `verifiedAt`, plus
   `statusReason` when present.
5. **Volunteer flow** — Claim → Start → upload proof → Resolve. Drive the buttons
   from `status` + `volunteerId` (see the matrix below).
6. **My work** — `?volunteerId=<me>` and `?reportedBy=<me>`.
7. **Points** — `GET /users/me/points`, balance plus history.
8. **Agency console** — `?status=AI_APPROVED` as the main queue, `?status=RESOLVED`
   for ones needing a closer look, with Confirm / Send back / Reject / Mark
   duplicate calling `PATCH /issues/:id/status`.

### Which buttons to show

Let `me` be the signed-in user and `i` the issue:

| Button | Show when |
|---|---|
| Edit | `i.reportedBy === me.id && i.status === 'OPEN'` |
| Add photo | `(i.status === 'OPEN' && i.reportedBy === me.id) \|\| (['CLAIMED','IN_PROGRESS'].includes(i.status) && i.volunteerId === me.id)`, and fewer than 5 files |
| Claim | `i.status === 'OPEN' && i.reportedBy !== me.id && me.roles.includes('CITIZEN')` |
| Release | `i.volunteerId === me.id && ['CLAIMED','IN_PROGRESS'].includes(i.status)` |
| Start work | `i.volunteerId === me.id && i.status === 'CLAIMED'` |
| Submit resolution | `i.volunteerId === me.id && ['CLAIMED','IN_PROGRESS'].includes(i.status)` and at least one PROOF photo of theirs |
| Confirm (VERIFIED) | `me.roles.includes('AGENCY') && ['RESOLVED','AI_APPROVED'].includes(i.status) && i.volunteerId !== me.id` |
| Send back / Reject / Duplicate | `me.roles.includes('AGENCY')` and the transition table allows it |

Treat this as a UI hint, never as the security boundary — the server re-checks
everything, and a 403 or 409 is always possible when your copy of the issue is stale.

---

## 10. Local setup

```bash
docker compose up -d      # MongoDB
npm install
npm run seed -- --fresh   # sample users and issues
npm run start:dev         # http://localhost:9000
```

Every seeded account uses the password **`Password123!`**:

| Email | Role |
|---|---|
| `citizen@civicon.test` | CITIZEN |
| `volunteer@civicon.test` | CITIZEN (the one who claims) |
| `agency@civicon.test` | AGENCY |
| `sponsor@civicon.test` | SPONSOR |
| `admin@civicon.test` | ADMIN |

There's a Postman collection at [`postman/`](../../postman/) covering every route,
which is the fastest way to see real payloads.

**Health check:** `GET /` and `GET /hello` are public and return plain text — fine
for an uptime probe.

---

## 11. What doesn't exist yet

Design around these absences; don't wait for them.

- **CORS** — see §0. The one true blocker.
- **Refresh tokens / logout** — a token dies after 7 days, and the user signs in again.
- **Total counts on lists** — no page numbers; use "Load more".
- **Public user profiles** — you can't turn a `reportedBy` id into a name.
- **Notifications** — nothing pushes. A volunteer learns their proof was rejected
  by reloading. If your screens need to feel live, poll the issue.
- **Search** — filter by the fields in §4 only; no free-text search.
- **Sponsors** — the role exists and does nothing. No funding, no bounties.
- **Spending points** — earn only; no rewards or leaderboard.
- **Reputation** — sits at 100 for everyone. Don't build UI on it.
- **Rate limiting** — skipped for the demo, so nothing stops a retry storm. Please
  don't retry failed requests in a tight loop.

---

## 12. A minimal client

```ts
const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:9000';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('token');
  const isForm = init.body instanceof FormData;

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      // Let the browser set Content-Type (and the boundary) for uploads.
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const message = Array.isArray(body.message)
      ? body.message.join('\n')
      : (body.message ?? 'Something went wrong');
    if (res.status === 401) localStorage.removeItem('token'); // stale session
    throw new ApiError(res.status, message);
  }

  return body as T;
}

export const api = {
  register: (b: { name: string; email: string; password: string }) =>
    request<AuthResponse>('/auth/register', { method: 'POST', body: JSON.stringify(b) }),

  login: (b: { email: string; password: string }) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify(b) }),

  me: () => request<PublicUser>('/auth/me'),

  listIssues: (q: Record<string, string | number> = {}) =>
    request<Issue[]>(`/issues?${new URLSearchParams(q as never)}`),

  getIssue: (id: string) => request<Issue>(`/issues/${id}`),

  createIssue: (b: CreateIssueBody) =>
    request<Issue>('/issues', { method: 'POST', body: JSON.stringify(b) }),

  uploadMedia: (issueId: string, file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<Media>(`/issues/${issueId}/media`, { method: 'POST', body });
  },

  claim:   (id: string) => request<Issue>(`/issues/${id}/claim`, { method: 'POST' }),
  release: (id: string) => request<Issue>(`/issues/${id}/claim`, { method: 'DELETE' }),
  start:   (id: string) => request<Issue>(`/issues/${id}/start`, { method: 'POST' }),

  resolve: (id: string, note: string) =>
    request<Issue>(`/issues/${id}/resolution`, { method: 'POST', body: JSON.stringify({ note }) }),

  changeStatus: (id: string, b: { status: IssueStatus; reason?: string; duplicateOf?: string }) =>
    request<Issue>(`/issues/${id}/status`, { method: 'PATCH', body: JSON.stringify(b) }),

  myPoints: () => request<{ balance: number; transactions: PointTransaction[] }>('/users/me/points'),

  mediaUrl: (media: Media) => `${BASE}${media.url}`,
};
```

Reporting an issue, end to end:

```ts
const issue = await api.createIssue({
  title, description, category: 'DRAINAGE', location,
});
for (const file of files.slice(0, 5)) {
  await api.uploadMedia(issue.id, file);   // sequentially; 5 per issue
}
const withMedia = await api.getIssue(issue.id);
```

---

Questions, or a field you need that isn't here (user names on issues, a total
count, notifications) — raise it with the backend team rather than working around
it. Most are small additions.
