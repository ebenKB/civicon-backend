<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
$ cp .env.example .env
```

## Database

MongoDB runs in Docker, pinned to the **8.0** long-term-support line. (8.1+ are
"rapid releases" — supported only until the next rapid release, so not suitable
for production.)

```bash
# start MongoDB in the background
$ docker compose up -d

# check it is healthy
$ docker compose ps

# open a shell against the database
$ docker compose exec mongodb mongosh -u root -p example --authenticationDatabase admin civicon

# stop it (data survives in the mongodb_data volume)
$ docker compose down

# stop it and wipe the data
$ docker compose down -v
```

### Seeding sample data

```bash
# upsert the sample users (safe to re-run)
$ npm run seed

# wipe the users collection first, then seed
$ npm run seed -- --fresh
```

Sample records live in [`src/seed.ts`](src/seed.ts).

### Demo accounts

`npm run seed` creates one account per actor. They all share the password
`Password123!`.

| Email | Roles |
| --- | --- |
| `citizen@civicon.test` | `CITIZEN` |
| `volunteer@civicon.test` | `CITIZEN` |
| `agency@civicon.test` | `AGENCY` |
| `sponsor@civicon.test` | `SPONSOR` |
| `admin@civicon.test` | `ADMIN` |

### Connection config

The `MONGO_*` variables in `.env` are the single source of truth: docker-compose
provisions the container with them, and the app composes its connection URI from
the same values ([`src/config/database.config.ts`](src/config/database.config.ts)).
Change a password or port once and both sides stay in sync.

For hosted deployments where the provider issues a connection string as a whole
(Atlas, replica sets), set `MONGODB_URI` — it overrides the parts.

## Authentication

Every route requires a bearer token unless it is marked `@Public()`. The public
routes are `GET /`, `GET /hello`, `POST /auth/register` and `POST /auth/login`;
everything else returns 401 without a valid token, and 403 when the caller
lacks the role a route requires.

```bash
# sign up — always creates a CITIZEN; there is no roles field to send
curl -X POST localhost:9000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","password":"super-secret"}'

# sign in
curl -X POST localhost:9000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"super-secret"}'

# who am I?
curl localhost:9000/auth/me -H "Authorization: Bearer $TOKEN"
```

Both `register` and `login` return `{ token, user }`. The token's claims carry
the user's roles, so guards need no database round-trip; `GET /auth/me` re-reads
the database and is therefore authoritative when roles have changed since the
token was issued.

The four roles are `CITIZEN`, `AGENCY`, `SPONSOR` and `ADMIN`. Registration
always creates a `CITIZEN` and accepts no `roles` field at all, so the other
three cannot be self-assigned — there is nothing to submit. They are granted by
the seed or by an admin through `PATCH /users/:id/roles`.

**There is deliberately no `VOLUNTEER` role**, diverging from §4.1 of the
execution guide. Volunteering is an action a citizen takes, not an identity they
hold: a claim is refused because of the *issue's* eligibility, lock and
assignment state, and anti-self-dealing compares `reportedBy` against
`volunteerId`. Neither reads a role, so a `VOLUNTEER` role would gate nothing.
The full argument, and what to build instead when `RESTRICTED` eligibility
arrives, is in
[the design spec](docs/superpowers/specs/2026-09-13-auth-identity-design.md#divergence-from-guide-41-no-volunteer-role).

Account creation lives only at `POST /auth/register`. The `/users` routes are
administration, restricted to `ADMIN`.

`JWT_SECRET` has no default and the app refuses to start without it. Generate
one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Because the app will not boot without it, any CI job running `npm run test:e2e`
must supply `JWT_SECRET` in its environment — `.env` is gitignored.

**Known gap:** there is no rate limiting on `POST /auth/login`. Adding
`@nestjs/throttler` to that route is the next thing this module needs.

### Postman collection

[`postman/`](postman/) holds an importable collection covering every auth and
user route, plus a **Guardrails** folder that asserts the security properties —
privileged roles cannot be self-assigned, a missing token is 401, a wrong role
is 403, and every login failure returns an identical message.

Import both files into Postman, or run them headlessly:

```bash
docker compose up -d && npm run seed && npm run start   # in one terminal
postman collection run postman/civicon-auth.postman_collection.json \
  -e postman/civicon-local.postman_environment.json
```

25 requests, 33 assertions. Sign-in requests capture their token into a
collection variable, so the rest of the collection authenticates itself. Each
folder obtains its own tokens and registers users under randomised emails, so
folders run independently and the collection can be re-run without a reseed.

Run just the security checks with `-i Guardrails`.

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Issues

A citizen reports a civic issue; anyone can read the record; an agency triages it.

| Route | Access |
|---|---|
| `POST /issues` | `CITIZEN` |
| `GET /issues` | public — filters `status`, `category`, `reportedBy`; paging `limit` (default 20, max 100), `offset` |
| `GET /issues/:id` | public |
| `PATCH /issues/:id` | the reporter, while the issue is `OPEN` |
| `PATCH /issues/:id/status` | `AGENCY` or `ADMIN` |

`reportedBy` comes from the token and `status` from the schema default, so a
request body can dictate neither — both are rejected as unknown properties.

Status changes happen in exactly one place, `IssueLifecycleService`. In this
slice an `OPEN` issue may become `REJECTED` (a `reason` is required) or
`DUPLICATE` (a `duplicateOf` id is required); every other transition returns
409 naming both states. Claiming and resolution are a later slice, which is why
`CLAIMED`, `IN_PROGRESS`, `RESOLVED` and `VERIFIED` exist in the enum but cannot
yet be reached.

```bash
TOKEN=$(curl -s -X POST localhost:9000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"citizen@civicon.test","password":"Password123!"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')

curl -s -X POST localhost:9000/issues -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Blocked drain","description":"Standing water.","category":"DRAINAGE","location":"Market Street"}'
```

### Claiming and resolving

A citizen other than the reporter takes an issue on, does the work, submits
evidence, and an agency confirms it.

| Route | Access |
|---|---|
| `POST /issues/:id/claim` | any `CITIZEN` except the reporter |
| `DELETE /issues/:id/claim` | the holder — returns it to `OPEN` |
| `POST /issues/:id/start` | the holder — `CLAIMED` to `IN_PROGRESS` |
| `POST /issues/:id/resolution` | the holder — needs a note and at least one proof photo |
| `PATCH /issues/:id/status` | `AGENCY`/`ADMIN` — verify, send back, or force-release |

```
OPEN ──claim──▶ CLAIMED ──start──▶ IN_PROGRESS ──resolve──▶ RESOLVED ──verify──▶ VERIFIED
  ▲                │                     │                      │
  └────── release / force-release ───────┘         send back ───┘
```

`IN_PROGRESS` is optional — a volunteer may resolve straight from `CLAIMED`.

**A reporter cannot claim their own issue** (403). That is the anti-self-dealing
rule: once civic points exist, reporting and resolving the same issue would be a
way to pay yourself.

Photos carry a `purpose` derived from the issue's state, never from the request:
uploaded while `OPEN` they are `REPORT`, uploaded by the holder they are
`PROOF`. A resolution counts only proof uploaded by the **current** holder, so
evidence left behind by a volunteer who released the claim does not count.

An agency cannot set `RESOLVED` directly — that would walk around the evidence
requirement — nor `CLAIMED`, which needs a volunteer the route cannot name.
Both return 403 rather than 409: the move is legal, just not for that actor.

`GET /issues?volunteerId=<id>` lists what someone is working on.

### Media

A reporter can attach photographs and short video to their own issue while it is
still `OPEN`. Anyone can view them — the bytes are public, so a plain `<img>` or
`<video src>` works with no token.

| Route | Access |
|---|---|
| `POST /issues/:id/media` | the reporter, while `OPEN` — multipart, field `file` |
| `GET /issues/:id/media` | public — metadata only |
| `GET /issues/media/:mediaId` | public — the bytes, with `Range` support |
| `DELETE /issues/media/:mediaId` | the reporter, while `OPEN` |

Limits, all defined in [`src/contracts/issue-media.ts`](src/contracts/issue-media.ts):
5 files per issue; images up to 5MB (`jpeg`, `png`, `webp`); video up to 50MB
(`mp4`, `webm`). A disallowed type is 415, an oversize file 413, a sixth file 409.

Bytes live in a GridFS bucket in the same MongoDB — a 50MB video cannot be a
document field, since that exceeds the 16MB BSON limit. Range requests are
honoured, so a browser can seek in a video rather than download it whole.
`IssueMediaService` is the only file that knows any of this, which is what keeps
a move to object storage a one-file change.

```bash
curl -X POST localhost:9000/issues/$ISSUE_ID/media \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@culvert.jpg;type=image/jpeg"
```

## Run tests

```bash
# unit tests — fully mocked, no database needed
$ npm run test

# e2e tests — REQUIRE a running MongoDB (docker compose up -d)
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

The e2e suite talks to a real database and truncates collections between tests,
so it runs against a **separate** database. `vitest.config.e2e.ts` redirects
`MONGO_DATABASE` to `<db>_test` (e.g. `civicon_test`), leaving development data
alone. As a backstop, the suite refuses to start if the connected database name
does not end in `_test`.

If you override the connection with a full `MONGODB_URI`, it is not rewritten —
connection strings can carry multiple hosts and options that do not survive
naive parsing. Set `MONGODB_URI_TEST` explicitly in that case; the suite fails
with a clear message if you don't.

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observer](https://observer.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
