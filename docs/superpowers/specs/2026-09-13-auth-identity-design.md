# Auth & Identity — Design

**Date:** 2026-09-13
**Status:** Approved, ready for implementation planning
**Scope:** Phase 1 identity slice only (auth), per the Trusted Civic Action Platform execution guide.

## Goal

Actors can sign up and sign in. On login the system knows what kind of user it is
dealing with, and every later phase can enforce that server-side rather than by
hiding UI.

This is the authentication and authorization backbone that Phases 2–6 depend on:
`@Roles(Role.AGENCY)` on an assign endpoint, `@Roles(Role.ADMIN)` on a review
queue, and `req.user.id` as the actor recorded in `issues.timeline[]`.

## Non-goals

Deliberately excluded from this slice:

- `IssueLifecycleService`, `PointsService`, and the other eight collections from
  guide §4.3 — the rest of Phase 1.
- Refresh tokens, token rotation, revocation lists.
- Password reset, email verification, OAuth, magic links.
- Agency ↔ user linkage (`agencyId`). Phase 3 needs it, but there is no
  `agencies` collection yet, and a dangling reference is worse than a later
  additive migration.
- Login rate limiting. This is a **known gap**, not an oversight: `@nestjs/throttler`
  on `/auth/login` is a ~10-minute follow-up and should be the next thing added.

## Context: what exists today

A standalone NestJS 12 backend (ESM, `"type": "module"`, TypeScript `nodenext`,
Node 24, Mongoose 9, Vitest). Not the monorepo the execution guide describes —
there is no `/apps/web` and no `/packages/contracts`.

Two facts shape this design:

- `src/users/users.controller.ts` exposes unauthenticated create / read / update /
  delete on users.
- `src/users/schemas/user.schema.ts` has `name`, `email`, `isActive` and nothing
  else — no `passwordHash`, no `roles[]`.

Established conventions this design follows: global `ValidationPipe`
(`whitelist` + `forbidNonWhitelisted`) and `MongoExceptionFilter` registered in
`AppModule` via `APP_PIPE` / `APP_FILTER` so tests share the production stack;
`.js` extensions on relative imports; unit tests beside sources, e2e specs in
`test/` against a `_test`-suffixed database.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scope | Auth only | Smallest slice that unblocks every later phase. |
| Roles | `CITIZEN`, `AGENCY`, `SPONSOR`, `ADMIN` — **no `VOLUNTEER`** (diverges from guide §4.1, see below) | A role that gates nothing is a UI state, not a role. |
| Role granting | Registration always creates a `CITIZEN` and accepts no `roles` field at all; `AGENCY`/`SPONSOR`/`ADMIN` are seeded or admin-granted | Guide §8 claims "agencies remain authoritative owners". Self-assignable `AGENCY` would make that claim false. With no field to submit, the gate is structural rather than validated. |
| Tokens | Single access JWT + `GET /auth/me` | Matches guide §4.4 exactly. No refresh machinery to design, store, or rotate. |
| Existing `/users` CRUD | `POST` dropped, remainder `ADMIN`-only | Registration becomes the single account-creation path; keeps an admin surface without a second password-less signup. |
| Guard wiring | Global `APP_GUARD`, `@Public()` opt-out | Default-deny. A route added in Phase 3 that forgets `@UseGuards` is still protected. |
| JWT library | `@nestjs/jwt`, no Passport | Three fewer dependencies and no CJS indirection for ~40 lines of guard. |
| Password hashing | `bcryptjs`, cost 12 | No native compiler needed in the Docker image. |

## 1. Contracts

New `src/contracts/` with a barrel `index.ts`, starting with `role.ts`:

```ts
export enum Role {
  CITIZEN = 'CITIZEN',
  AGENCY = 'AGENCY',
  SPONSOR = 'SPONSOR',
  ADMIN = 'ADMIN',
}
```

Later phases add their enums, types and the issue state-machine transition map
to this folder.

There is no web app in this repository, so `/packages/contracts` cannot exist
yet. Guide rule #2 — "never redefine a shape locally, import it from the shared
contracts package" — still applies, and a folder that later moves wholesale into
a workspace package costs nothing now.

### Divergence from guide §4.1: no `VOLUNTEER` role

The guide lists five roles and notes that a user may hold both `CITIZEN` and
`VOLUNTEER`. This implementation has four. **Volunteering is an action a citizen
takes, not an identity they hold.**

The reason is that `VOLUNTEER` gates nothing. Per the guide's own state machine,
a claim is refused when the issue is `GOVERNMENT_ONLY`, locked, `ASSIGNED`, or
already claimed — every one of those a property of *the issue*, not of the
actor. Anti-self-dealing (guide §5) compares `issue.reportedBy` against
`contribution.volunteerId`: identity, not role. So `@Roles(Role.VOLUNTEER)` on
the claim endpoint would exclude exactly one person — a citizen who had not
ticked a box — and excluding them buys no safety.

Since every volunteer is necessarily a citizen, the role never partitioned the
user base; it was a flag on some citizens that no authorization decision read.

Consequences, all of them simplifications:

- Registration accepts no `roles` field. There is no self-assignment gate to
  validate, because there is nothing to submit. An attempt to send `roles` is
  rejected as an unknown property by the global `forbidNonWhitelisted` pipe.
- No role-implication normalization is needed anywhere.
- `contributions.volunteerId` is unaffected. As a field name it denotes *the
  citizen who did this work* — a relationship, not a role.

**When this decision should be revisited:** the guide's `RESTRICTED`
eligibility tier implies vetted or trained volunteers. That is a credential and
wants to be per-category (`trainedFor: [IssueCategory]`) or a verification
level — a boolean role cannot express it. An explicit safety-terms opt-in is
likewise a timestamp worth auditing (`volunteerAgreementAcceptedAt`), not a
role. Build either when `RESTRICTED` actually ships; neither resurrects
`VOLUNTEER`.

## 2. User schema

Extends `src/users/schemas/user.schema.ts`:

| Field | Type | Notes |
|---|---|---|
| `passwordHash` | `string` | `required: true`, **`select: false`** |
| `roles` | `Role[]` | enum-validated, `default: [Role.CITIZEN]` |
| `civicPointsCached` | `number` | `default: 0` |
| `reputation` | `number` | `default: 100` |

`isActive` already exists and is reused: login rejects inactive accounts.

`select: false` on `passwordHash` means every existing and future `find()` omits
it by default; only an explicit `.select('+passwordHash')` retrieves it, and that
call appears in exactly one place (`UsersService.findByEmailWithPassword`). The
existing `toJSON` transform additionally does `delete ret.passwordHash` as a
second line of defence.

`civicPointsCached` is a **cache**, per the guide §4.3 ledger rule: the truth is
the sum of `point_transactions`. Nothing in this slice writes to it; it exists so
the login payload has the field Phase 5 will populate.

**Migration consequence:** `required: true` invalidates the five existing seeded
users, which have no `passwordHash`. The seed rewrite (§8) gives them hashes;
`npm run seed -- --fresh` is required once after this change.

## 3. Module layout

```
src/contracts/
  index.ts
  role.ts

src/auth/
  auth.module.ts
  auth.controller.ts               POST /auth/register · POST /auth/login · GET /auth/me
  auth.service.ts                  register · validateCredentials · issueToken
  password.service.ts              hash · compare
  dto/register.dto.ts
  dto/login.dto.ts
  guards/jwt-auth.guard.ts
  guards/roles.guard.ts
  decorators/public.decorator.ts
  decorators/roles.decorator.ts
  decorators/current-user.decorator.ts
  types/jwt-payload.ts
  types/authenticated-user.ts
```

`PasswordService` is separated from `AuthService` so the hashing algorithm is
swappable (to `argon2`, say) without touching authentication logic, and so it can
be unit-tested on its own.

## 4. Identity on login

Three layers, each with a distinct job.

**JWT claims** — `{ sub, email, roles, iat, exp }` where `sub` is the user id and
`roles` is `Role[]`. `JwtAuthGuard` verifies the signature and attaches
`req.user = { id, email, roles }` built from the claims alone. No database
round-trip per request.

**Login / register response** — guide §4.4's `{ token, user }`:

```json
{
  "token": "<jwt>",
  "user": {
    "id": "…",
    "name": "Ada Lovelace",
    "email": "ada@example.com",
    "roles": ["CITIZEN"],
    "civicPointsCached": 0,
    "reputation": 100
  }
}
```

The frontend selects its citizen / agency / sponsor shell from `user.roles`.
The server never trusts that choice. A citizen's reporting and volunteering
views are two faces of the same shell, gated by what each issue allows rather
than by who the viewer is.

**`GET /auth/me`** — re-reads the user from Mongo and returns the same sanitized
shape, so it reflects *authoritative current* roles. This is the escape hatch for
"an admin granted you `AGENCY` after your token was issued": the client refetches
rather than forcing a re-login.

**`RolesGuard`** performs enforcement: it reads `@Roles(...)` metadata via
`Reflector` (handler then class) and requires a non-empty intersection with
`req.user.roles`. Holding any one of several required roles is enough, so a
route may name two and accept either.

A route with no `@Roles()` metadata requires authentication but no particular
role.

## 5. Guard wiring

Both guards are registered globally in `AppModule` via `APP_GUARD`, `JwtAuthGuard`
first and `RolesGuard` second (Nest runs global guards in registration order, so
`req.user` is populated before roles are checked).

`@Public()` sets a metadata key that `JwtAuthGuard` checks first and short-circuits
on. It short-circuits unconditionally: a `@Public()` route does not parse a token
even when one is supplied, so `req.user` is `undefined` there. (Guide Phase 2's
`GET /issues` browse list is the one route that may later want optional identity;
when it does, it gets an explicit optional-auth guard rather than a change here.)
Public routes: `GET /`, `GET /hello`, `POST /auth/register`, `POST /auth/login`.
(There is no `/health` route yet — guide Phase 0 adds one, and it will be `@Public()`.)

Global rather than per-controller because guide §9's Definition of Done demands
server-side enforcement of role permissions. With global guards, a Phase 3 route
that forgets `@UseGuards` fails closed with a 401 instead of silently shipping an
open endpoint.

## 6. Registration

```ts
export class RegisterDto {
  @IsString() @IsNotEmpty() name: string;
  @IsEmail() email: string;
  @IsString() @MinLength(8) @MaxLength(72) password: string;
}
```

Three fields. **No `roles`.** Registration always creates a `CITIZEN`, which the
schema supplies as the default.

This is the structural form of the self-assignment gate. An earlier draft
accepted an optional `roles` array and validated it against a whitelist; with
`VOLUNTEER` gone there is nothing legitimate left to put there, so the field is
removed outright. A request carrying `roles` is now rejected as an **unknown
property** by the global `forbidNonWhitelisted` pipe — still a 400, but because
the field does not exist rather than because a validator turned it down. There
is no gate to get wrong.

`MaxLength(72)`: bcrypt silently truncates input beyond 72 bytes, so a longer
password would make trailing characters meaningless. Rejecting is honest.

`AGENCY`, `SPONSOR` and `ADMIN` accounts are created two ways: the seed script,
or `PATCH /users/:id/roles` (`ADMIN`-only), which accepts the full `Role` enum.

**Login responses are uniform.** Unknown email, wrong password, and inactive
account all return `401 Unauthorized` with the identical message
("Invalid credentials"), so the endpoint cannot be used to enumerate registered
users. The inactive case is deliberately folded in: distinguishing it would leak
that the address is registered.

Registration of a duplicate email returns `409` via the existing
`MongoExceptionFilter` unique-index path.

## 7. Users module changes

- `POST /users` **deleted**. Registration is the only account-creation path; a
  second, password-less one would produce users who cannot log in.
- `GET /users`, `GET /users/:id`, `PATCH /users/:id`, `DELETE /users/:id` gain
  `@Roles(Role.ADMIN)`.
- New `PATCH /users/:id/roles` (`ADMIN`-only), body `{ roles: Role[] }` validated
  against the full `Role` enum. This is how `AGENCY` accounts are created without
  a reseed. Semantics are **replace, not merge**: the supplied array becomes the
  user's roles, so the endpoint both grants and revokes. The array must be
  non-empty — a roleless user would be able to log in but do nothing.
- `UsersService` gains `findByEmailWithPassword(email)` — the only
  `.select('+passwordHash')` call in the codebase — and `createWithPassword(...)`.
- `UpdateUserDto` continues to derive from the password-free `CreateUserDto`, so
  `PATCH /users/:id` cannot set `roles` or `passwordHash`. Combined with the
  global `forbidNonWhitelisted` pipe, an attempt returns 400.

## 8. Configuration and seed

Added to `.env` and `.env.example`:

```
# --- Auth ---
# No default is provided on purpose: a fallback development secret is exactly
# the secret that reaches production. The app refuses to boot without this.
JWT_SECRET=
JWT_EXPIRES_IN=7d
```

`JwtModule.registerAsync` reads both from `ConfigService` and **throws at boot**
if `JWT_SECRET` is empty or absent.

The seed script grows an account per role, all sharing a documented demo
password, and gives the existing sample users hashes.

There are deliberately **two** citizen accounts. `volunteer@civicon.test` holds
no special role — the name describes what that person does, not what they are —
and exists so the anti-self-dealing rule has two distinct actors to demonstrate:
one citizen reports an issue, a different citizen acts on it.

| Email | Roles |
|---|---|
| `citizen@civicon.test` | `CITIZEN` |
| `volunteer@civicon.test` | `CITIZEN` |
| `agency@civicon.test` | `AGENCY` |
| `sponsor@civicon.test` | `SPONSOR` |
| `admin@civicon.test` | `ADMIN` |

The seed must hash passwords through `PasswordService` (obtained from the
application context it already builds) rather than embedding precomputed hashes,
so a change of cost factor or algorithm does not leave stale hashes behind. The
credentials are documented in the README under a new "Demo accounts" heading.

## 9. Error contract

| Situation | Status | Body message |
|---|---|---|
| Register, duplicate email | 409 | `A record with this email already exists` (existing filter) |
| Register, privileged role requested | 400 | validation error naming `roles` |
| Register, password under 8 chars | 400 | validation error naming `password` |
| Login, unknown email / wrong password / inactive | 401 | `Invalid credentials` |
| Any protected route, no or malformed token | 401 | `Unauthorized` |
| Any protected route, expired token | 401 | `Unauthorized` |
| Authenticated but wrong role | 403 | `Forbidden resource` |

## 10. Testing

Test-driven: each behaviour below gets a failing test before its implementation.

**Unit**

- `PasswordService`: hash then compare succeeds; compare fails on a wrong
  password; two hashes of the same input differ (salting).
- `AuthService.register`: hashes the password (never stores plaintext); always
  assigns `[CITIZEN]`; returns a token plus a sanitized user with no
  `passwordHash`.
- `UsersService.setRoles`: replaces rather than merges; an empty array is
  rejected.
- `AuthService.validateCredentials`: unknown email, wrong password and inactive
  user all raise the same `UnauthorizedException` message.
- `RolesGuard`: no metadata → allow; single matching role → allow; dual-role user
  matching one of two required roles → allow; no overlap → deny; missing
  `req.user` → deny.
- `JwtAuthGuard`: valid token populates `req.user`; malformed, unsigned, wrongly
  signed and expired tokens all reject; `@Public()` route passes without a token.

**E2E** (`test/auth.e2e-spec.ts`)

- register → login → `GET /auth/me` returns the expected `roles`.
- register with `roles: ['ADMIN']` → 400 (unknown property); the user is not
  created. The same holds for `AGENCY` and `SPONSOR`.
- register with a duplicate email → 409.
- `GET /auth/me` with no token → 401.
- A `CITIZEN` token against `GET /users` → 403.
- A seeded `ADMIN` token against `GET /users` → 200.
- No response body anywhere contains `passwordHash`.

**Existing suites to update:** `test/users.e2e-spec.ts` must authenticate as an
admin and drop its `POST /users` cases; `test/hello.e2e-spec.ts` and
`test/app.e2e-spec.ts` confirm their routes stay reachable via `@Public()`.

## 11. Dependencies

Added: `@nestjs/jwt`, `bcryptjs`, `@types/bcryptjs` (dev).

Passport is rejected: `@nestjs/passport` + `passport` + `passport-jwt` is three
further dependencies and a CJS indirection layer inside an ESM codebase, for what
is a ~40-line guard over `JwtService.verifyAsync`.

`bcryptjs` over native `bcrypt` or `argon2` because it is pure JavaScript and
needs no build toolchain in the Docker image. Cost factor 12. If hashing latency
ever matters, `PasswordService` is the single file to change.

## 12. Risks

| Risk | Mitigation |
|---|---|
| `required: true` on `passwordHash` invalidates existing user documents | Seed rewrite; `npm run seed -- --fresh` documented in the README |
| Global guards break the three existing e2e suites | Updating them is explicit work in the plan, not a surprise |
| Roles in JWT claims go stale after an admin grant | `GET /auth/me` returns authoritative roles; token lifetime is bounded at 7d |
| No login rate limiting | Documented as a known gap; `@nestjs/throttler` is the named follow-up |
| `select: false` forgotten somewhere, leaking a hash | Single `.select('+passwordHash')` call site; `toJSON` deletes the field; an e2e assertion checks no response contains it |

## Definition of Done

- Each of the five seeded roles can log in and receive a token whose claims carry
  its roles.
- `GET /auth/me` returns the authoritative current roles for the bearer.
- Registering with `AGENCY`, `SPONSOR` or `ADMIN` is rejected with a 400 at the
  API, not merely hidden in a UI.
- An unauthenticated request to any non-`@Public()` route returns 401; an
  authenticated request lacking the required role returns 403.
- No HTTP response anywhere in the suite contains `passwordHash`.
- `npm run test`, `npm run test:e2e` and `npm run lint` all pass.
