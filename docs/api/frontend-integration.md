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

**1. CORS allows every origin — for now.** The server calls `enableCors()`
with no allowlist, so any origin can call the API from a browser. That's safe
only because auth is a bearer token in the `Authorization` header, never a
cookie. It will be narrowed to an allowlist before any real deployment (a
TODO in `src/main.ts`), so tell the backend team your deployed origin.

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
listing its media, downloading a file, and fetching the hazard question bank.

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

type HazardLevel =
  | 'UNCLASSIFIED'  // created, not yet submitted for classification — never claimable
  | 'UNRESTRICTED'  // ordinary volunteer work — the ONLY claimable value
  | 'RESTRICTED'    // needs a specialist; only an agency can resolve it
  | 'NEEDS_REVIEW'; // nobody is confident enough yet — waiting on an agency

type HazardSource = 'REPORTER' | 'AI' | 'AGENCY' | 'ADMIN';

type HazardAnswer = 'YES' | 'NO' | 'UNSURE';
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
  volunteer?: {               // who holds it, named
    id: string
    name?: string             // absent if the account was deleted
  }
  claimedAt?: string
  resolutionNote?: string     // what the volunteer says they did
  resolvedAt?: string
  verifiedAt?: string
  aiAssessment?: AiAssessment // see §6

  hazard: HazardLevel           // UNRESTRICTED is the only claimable value — see §4a
  hazardAssessment?: {
    level: HazardLevel
    source: HazardSource
    confidence?: number         // 0–1; absent when a human decided
    reasoning?: string          // the model's reasoning, or the human's mandatory reason
    model?: string
    assessedAt: string
  }
  observations: string[]        // question ids the reporter ticked when reporting
  pendingQuestions?: string[]   // question ids sent to the reporter, not yet answered
  answers?: { questionId: string; answer: HazardAnswer }[]

  createdAt: string
  updatedAt: string
}
```

**The volunteer is named; the reporter is not.** That asymmetry is deliberate.
`GET /issues` is public, so a name beside every report would tell anyone who
complained about what — a real risk when the report names a hazard or someone's
negligence. A volunteer is a public actor by choice: the points they earn are
credit for exactly this work.

So `reportedBy` stays a bare id and there is **no public endpoint for another
user's profile** (`GET /users/:id` is admin-only). Render "you" when
`reportedBy` matches the signed-in user's id, and otherwise leave the reporter
anonymous. If an agency ever needs to contact a reporter, that's an
authenticated, role-gated endpoint — ask for it rather than expecting the name
in this payload.

### GET /issues — public

The main feed. Newest first.

| Query | Values |
|---|---|
| `status` | any `IssueStatus` |
| `category` | any `IssueCategory` |
| `reportedBy` | user id |
| `volunteerId` | user id (the query parameter keeps this name) |
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
- Hazard queues: `?hazard=NEEDS_REVIEW` (unsure verdicts) and `?hazard=UNCLASSIFIED`
  (reports never submitted for classification) — see §4a

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

An optional fifth field, `observations`, lets the reporter tick what they can
see — see §4a immediately below.

**201** → the new `Issue` (status `OPEN`, `hazard: 'UNCLASSIFIED'`, `media: []`).
Photos are a **second step** (§5); classification is a **third** (§4a). None of
this issue is claimable by anyone until it clears classification.

**403** if the account doesn't hold CITIZEN. An agency-only account cannot report.

### PATCH /issues/:id — the reporter, while OPEN

Same four fields, all optional. Send only what changed.

**403** you didn't report it (admins get 403 too — rewriting someone's account of
what they saw isn't an admin power)
**409** the issue has moved past OPEN and can no longer be edited

**Editing withdraws a clearance.** If the issue was `UNRESTRICTED` and you change
`title`, `description`, `category` or `location`, it drops back to
`UNCLASSIFIED` and stops being claimable — the verdict was about text that no
longer exists, so it has to be classified again. The response carries the new
`hazard`, so read it rather than assuming the edit was cosmetic, and send the
reporter back through step 3.

A `RESTRICTED` or `NEEDS_REVIEW` issue is **not** reset by an edit: an edit can
take an issue out of the claimable state, never out of a restriction. And
`observations` cannot be changed here at all — sending the key is a **400**.

### 4a. Hazard classification — the three-step flow

Not every issue is safe for a member of the public to fix. `hazard` gates
`POST /issues/:id/claim`: **`UNRESTRICTED` is the only claimable value.** A
freshly reported issue is `UNCLASSIFIED` and cannot be claimed until it goes
through this flow.

**Fetch the questions; do not hardcode them.** `GET /hazard/questions` is
public — no token — and serves the whole bank:

```json
{
  "observations": [
    { "id": "obs-wires", "text": "I can see loose, broken or hanging electrical wires", "kind": "OBSERVATION" }
  ],
  "followUps": [
    { "id": "elec-1", "text": "Are any wires hanging down, broken, or lying on the ground?", "kind": "FOLLOW_UP" }
  ]
}
```

`observations` are the checkboxes for the report form; `followUps` is the pool
`pendingQuestions` draws from, so fetching once gives you the text for both.
The response is cacheable for an hour and only changes on a redeploy — fetch it
at app start and keep it.

The ids are a stable contract, but **the wording is not**: it is still awaiting
review by someone with field-safety knowledge, and it is read by people standing
next to a hazard. A copy pasted into the client would go stale silently, and two
systems would be asking different safety questions. The lists below are for
reading while you build, not for shipping.

**Step 1 — tick what you can see, when reporting.** `POST /issues` (above)
takes an optional `observations` array of question ids. Offer them as checkboxes
on the report form. Ticking any one of them restricts the issue outright once
classified — no AI call needed for that verdict.

```ts
const OBSERVATION_QUESTIONS = [
  { id: 'obs-wires',           text: 'I can see loose, broken or hanging electrical wires' },
  { id: 'obs-water-electric',  text: 'Water is touching something electrical' },
  { id: 'obs-collapse',        text: 'Part of a structure has collapsed, or is leaning' },
  { id: 'obs-gas',             text: 'There is a smell of gas or fuel' },
  { id: 'obs-deep-water',      text: 'The water is deep or moving fast' },
  { id: 'obs-traffic',         text: 'It is in a lane where vehicles are still driving' },
];
```

There's no endpoint that serves this list — it's a fixed, stable server
contract (ids are never reused once retired), so hardcode it exactly like the
enumerations in §3.

**Step 2 — classify.** `POST /issues/:id/classification` — the reporter, no
body needed the first time.

```
POST /issues/507f.../classification
{}
```

**200** → the updated `Issue`. Read `hazard`:

| `hazard` | What happened | What to show |
|---|---|---|
| `UNRESTRICTED` | Cleared — a volunteer can claim it | "Looks like ordinary work" |
| `RESTRICTED` | An observation was ticked, or the AI was confident it's dangerous | "This needs a specialist — an agency will handle it" |
| `NEEDS_REVIEW` with `pendingQuestions: []` | The AI couldn't decide and had no good follow-up questions (or there's no `ANTHROPIC_API_KEY` configured at all) | "Waiting for an agency to take a look" |
| `NEEDS_REVIEW` with `pendingQuestions: [...]` | The AI has 3–5 follow-up questions that would settle it | Show them, go to step 3 |

**This call is synchronous — it can take up to roughly a minute or two in the
worst case** (photographs, or especially video, add real latency to the model
call). Show a spinner that tolerates a slow response; don't assume it's fast
like the other mutation routes.

**409** if the issue was already classified and you call this again with no
`answers` — check `hazard !== 'UNCLASSIFIED'` before showing this step as
available.

**Step 3 — answer the follow-ups, or wait.** Only when step 2 came back with
`pendingQuestions`. Those are ids from the `followUps` half of
`GET /hazard/questions`; look each one up there to render it. Each answer is `'YES' | 'NO' | 'UNSURE'`.

```ts
const FOLLOW_UP_QUESTIONS = [
  { id: 'elec-1',    text: 'Are any wires hanging down, broken, or lying on the ground?' },
  { id: 'elec-2',    text: 'Is anything electrical in contact with water?' },
  { id: 'elec-3',    text: 'Is the pole or its cover damaged, leaning, or open?' },
  { id: 'elec-4',    text: 'Can you hear buzzing, see sparks, or smell burning?' },
  { id: 'water-1',   text: 'Is the water deeper than knee height?' },
  { id: 'water-2',   text: 'Is the water moving fast enough to push against your legs?' },
  { id: 'water-3',   text: 'Is a drain or manhole cover missing or open?' },
  { id: 'traffic-1', text: 'Are vehicles still driving past the spot?' },
  { id: 'traffic-2', text: 'Would someone working on this have to stand in the road?' },
  { id: 'traffic-3', text: 'Is this on a main road rather than a side street?' },
  { id: 'struct-1',  text: 'Has any part of a wall, roof, pole or bridge already fallen?' },
  { id: 'struct-2',  text: 'Is anything leaning, cracked, or looking likely to fall?' },
  { id: 'struct-3',  text: 'Is there loose material overhead?' },
  { id: 'gas-1',     text: 'Can you smell gas, petrol or diesel?' },
  { id: 'gas-2',     text: 'Is there any fire, smoke, or heat coming from it?' },
  { id: 'height-1',  text: 'Would someone need a ladder, or to climb, to reach it?' },
  { id: 'height-2',  text: 'Is it above head height?' },
  { id: 'gen-1',     text: 'Is there broken glass, sharp metal, or medical waste?' },
  { id: 'gen-2',     text: 'Is anything chemical leaking or spilled?' },
  { id: 'gen-3',     text: 'Is the area already fenced off, taped off, or being guarded?' },
];
```

Call the **same** classification route again, this time with every pending
question answered and nothing else:

```json
POST /issues/507f.../classification
{
  "answers": [
    { "questionId": "elec-1", "answer": "YES" },
    { "questionId": "elec-2", "answer": "NO" },
    { "questionId": "water-1", "answer": "UNSURE" }
  ]
}
```

**200** → the updated `Issue`, `hazard` now settled one way or the other (a
second pass never asks a third round — it decides or falls to `NEEDS_REVIEW`
for a human). **400** if you don't answer exactly the questions that were
asked — no more, no fewer. **409** if the issue isn't currently waiting on any
answers (`pendingQuestions` is empty), which is also what you get if an agency
ruled on it while the reporter was still typing.

**One more 409 worth handling on either call:** `"This issue was already decided
while classification was running"`. The classification call can take a minute,
and an agency working the queue can decide in that window; the human decision
wins and yours is refused rather than silently overwriting it. The same happens
if the reporter edits the issue, or adds a photo, while their own classification
is in flight. In every case: refetch the issue and show its current state. It is
not an error the user caused.

**If it lands on `NEEDS_REVIEW` with no further questions, there is nothing
more the reporter can do.** It waits in the agency's queue
(`?hazard=NEEDS_REVIEW`) until a human decides.

### PATCH /issues/:id/hazard — AGENCY or ADMIN

The human decision, for anything classification couldn't settle (or to
override any hazard level by hand).

```json
{ "level": "UNRESTRICTED", "reason": "Checked in person, no live wires" }
```

Only `RESTRICTED` and `UNRESTRICTED` are settable here — `NEEDS_REVIEW` and
`UNCLASSIFIED` are states the system arrives at, never ones a person chooses.

**200** → the updated `Issue`, with `hazardAssessment.source` set to `AGENCY` or
`ADMIN`. Which staff user decided is recorded server-side but deliberately not
returned: this payload is served on token-free public routes. **400** no
`reason` (capped at 500 characters, same as `statusReason`). **403** a citizen
calling this route at all.

### The three claim refusals

`POST /issues/:id/claim` checks `hazard` **before** anything else — before
"already claimed", before "you reported this yourself" — so the message always
names the real reason:

| `hazard` | Refusal |
|---|---|
| `UNCLASSIFIED` | `"This issue has not been classified yet"` |
| `NEEDS_REVIEW` | `"This issue is waiting for an agency to review it"` |
| `RESTRICTED` | `"This issue needs specialist handling and cannot be claimed"` |

All three are **403**. Hide or disable the Claim button unless
`issue.hazard === 'UNRESTRICTED'` rather than relying on the server response —
these aren't states a retry gets you out of.

**A `RESTRICTED` issue is never a dead end.** An agency resolves it directly
through the ordinary `POST /issues/:id/resolution` and
`PATCH /issues/:id/status` routes below, while holding the `AGENCY` role —
attaching evidence and writing a note exactly as a volunteer would. The only
differences: it pays no civic points (there's no volunteer), and the same
"can't confirm your own work" rule applies to the agency that resolved it, not
just to a volunteer.

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
| `POST /issues/:id/claim` | any CITIZEN except the reporter | OPEN → CLAIMED | **409** already claimed · **403** you reported it, or `hazard !== 'UNRESTRICTED'` (§4a) · **409** not OPEN |
| `DELETE /issues/:id/claim` | the holder | back to OPEN; clears `volunteer`, `claimedAt`, `resolvedAt`, `resolutionNote` | **403** not the holder |
| `POST /issues/:id/start` | the holder | CLAIMED → IN_PROGRESS | **403** not the holder |
| `POST /issues/:id/resolution` | the holder, or an AGENCY actor when `hazard === 'RESTRICTED'` | → RESOLVED (or AI_APPROVED) | **400** no proof photo · **403** not the holder (and not AGENCY on a restricted issue) |

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
- `OPEN` (force-release) clears `volunteer`, `claimedAt`, `resolvedAt` and
  `resolutionNote`. The issue is free for anyone to claim again.
- `statusReason` is **overwritten on every status change** — including with
  nothing when no `reason` is sent, as on `VERIFIED`. Never assume a
  `statusReason` you saw earlier is still there.

**A user cannot confirm their own work.** Someone holding both CITIZEN and AGENCY
who fixed the issue themselves — or an AGENCY actor who resolved a `RESTRICTED`
issue themselves — gets:

```json
{ "statusCode": 403, "message": "You cannot verify work you did yourself", "error": "Forbidden" }
```

Hide the confirm button when `issue.volunteer?.id === currentUser.id`. The
agency-resolver case can't be pre-empted the same way today — the resolving
agency user's id isn't in the `Issue` payload (§4's object shape), only
`hazard` and the transition history — so an agency account that resolved a
`RESTRICTED` issue itself will hit this 403 on click rather than have the
button hidden in advance. Handle it as a normal error toast.

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
| `RESTRICTED`, while `OPEN` / `CLAIMED` / `IN_PROGRESS` | an agency only | `PROOF` |
| `OPEN` | the reporter only | `REPORT` (the "before" photo) |
| `CLAIMED` / `IN_PROGRESS` | the holding volunteer only | `PROOF` (the "after" photo) |
| anything else | nobody | **409** |

The hazard row is checked first, and refusing there gives **403** `"This issue
needs specialist handling; only an agency can attach evidence"`. So on a
restricted issue neither the reporter nor a volunteer holding it may attach
anything — the work is the agency's, and
so is the evidence. That holds even for an issue a volunteer claimed before it
was reclassified.

**Attaching a `REPORT` photo withdraws a clearance**, the same way editing the
text does: new evidence the classifier never saw means an `UNRESTRICTED` issue
drops back to `UNCLASSIFIED` and must be classified again. A `PROOF` upload
never affects the hazard.

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

**204**, no body. **You may only delete a file you uploaded yourself.** Issue
ownership is not enough — since an agency can attach proof to a restricted issue
that is still `OPEN`, a reporter deleting "their" issue's media could otherwise
delete the agency's evidence. Anything else is **403** `"You can only remove
media you attached yourself"`.

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
   from `status` + `volunteer?.id` (see the matrix below).
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
| Add photo | `(i.status === 'OPEN' && i.reportedBy === me.id && i.hazard !== 'RESTRICTED') \|\| (['CLAIMED','IN_PROGRESS'].includes(i.status) && i.volunteer?.id === me.id) \|\| (me.roles.includes('AGENCY') && i.hazard === 'RESTRICTED' && ['OPEN','IN_PROGRESS'].includes(i.status))`, and fewer than 5 files |
| Classify | `i.hazard === 'UNCLASSIFIED' && i.reportedBy === me.id` |
| Answer hazard questions | `i.hazard === 'NEEDS_REVIEW' && i.pendingQuestions?.length && i.reportedBy === me.id` |
| Claim | `i.status === 'OPEN' && i.hazard === 'UNRESTRICTED' && i.reportedBy !== me.id && me.roles.includes('CITIZEN')` |
| Release | `i.volunteer?.id === me.id && ['CLAIMED','IN_PROGRESS'].includes(i.status)` |
| Start work | `i.volunteer?.id === me.id && i.status === 'CLAIMED'` |
| Submit resolution | `(i.volunteer?.id === me.id && ['CLAIMED','IN_PROGRESS'].includes(i.status))` or `(me.roles.includes('AGENCY') && i.hazard === 'RESTRICTED' && i.status === 'OPEN')`, either way gated on at least one PROOF photo of theirs |
| Confirm (VERIFIED) | `me.roles.includes('AGENCY') && ['RESOLVED','AI_APPROVED'].includes(i.status) && i.volunteer?.id !== me.id` — but see the note below: this predicate cannot also catch an agency confirming its own restricted-issue resolution |
| Send back / Reject / Duplicate | `me.roles.includes('AGENCY')` and the transition table allows it |

The reporter is refused a claim on their own issue, but so is anyone once
`hazard` is anything other than `UNRESTRICTED` — a `RESTRICTED` `OPEN` issue is
the agency's to fix, not the reporter's to keep adding photos to. See §4a and
the agency-resolution note under §4's claim refusals.

Editing `title`, `description`, `category` or `location` on an issue that has
already been classified — or attaching a new REPORT photo to one — resets
`hazard` back to `UNCLASSIFIED` and clears `hazardAssessment`,
`pendingQuestions` and `answers`: the existing verdict was about the text and
photos the classifier actually read, and either of those actions changes what
it saw. The reporter must submit for classification again (§4a, step 2). An
edit or upload that doesn't change any of those inputs — resubmitting the same
title, say — leaves the classification alone.

**Confirm** also can't be hidden client-side for the one case above the
predicate doesn't cover: an agency account that resolved a `RESTRICTED` issue
itself. The resolving agency's id isn't part of the `Issue` payload, so that
attempt reaches the button, gets a 403, and needs to be handled as an error
rather than prevented — see the self-dealing note under §4's `PATCH
/issues/:id/status`.

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

- **A CORS allowlist** — every origin is allowed today (§0).
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

  // Synchronous — can take up to roughly a minute or two in the worst case.
  classify: (id: string, answers?: { questionId: string; answer: HazardAnswer }[]) =>
    request<Issue>(`/issues/${id}/classification`, {
      method: 'POST',
      body: JSON.stringify(answers ? { answers } : {}),
    }),

  setHazard: (id: string, b: { level: 'RESTRICTED' | 'UNRESTRICTED'; reason: string }) =>
    request<Issue>(`/issues/${id}/hazard`, { method: 'PATCH', body: JSON.stringify(b) }),

  claim:   (id: string) => request<Issue>(`/issues/${id}/claim`, { method: 'POST' }),
  release: (id: string) => request<Issue>(`/issues/${id}/claim`, { method: 'DELETE' }),
  start:   (id: string) => request<Issue>(`/issues/${id}/start`, { method: 'POST' }),

  resolve: (id: string, note: string) =>
    request<Issue>(`/issues/${id}/resolution`, { method: 'POST', body: JSON.stringify({ note }) }),

  changeStatus: (id: string, b: { status: IssueStatus; reason?: string; duplicateOf?: string }) =>
    request<Issue>(`/issues/${id}/status`, { method: 'PATCH', body: JSON.stringify(b) }),

  myPoints: () => request<{ balance: number; transactions: PointTransaction[] }>('/users/me/points'),

  // Public, cacheable, changes only on a redeploy — fetch once at app start
  // rather than hardcoding the wording.
  hazardQuestions: () =>
    request<{
      observations: HazardQuestion[];
      followUps: HazardQuestion[];
    }>('/hazard/questions'),

  mediaUrl: (media: Media) => `${BASE}${media.url}`,
};
```

Reporting an issue, end to end — three steps, the last of which the user
waits through:

```ts
const issue = await api.createIssue({
  title, description, category: 'DRAINAGE', location,
  observations: tickedObservationIds,      // [] or omitted if none were ticked
});
for (const file of files.slice(0, 5)) {
  await api.uploadMedia(issue.id, file);   // sequentially; 5 per issue
}

// Synchronous — show a spinner that tolerates up to a minute or two.
let classified = await api.classify(issue.id);
if (classified.hazard === 'NEEDS_REVIEW' && classified.pendingQuestions?.length) {
  const answers = await askTheReporter(classified.pendingQuestions); // your UI
  classified = await api.classify(issue.id, answers);
}
// classified.hazard is now UNRESTRICTED, RESTRICTED, or a NEEDS_REVIEW that
// only an agency can move — either way, the report itself is done.
```

---

Questions, or a field you need that isn't here (user names on issues, a total
count, notifications) — raise it with the backend team rather than working around
it. Most are small additions.
