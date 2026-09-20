# Hazard Classification — Design

Any signed-in citizen can currently claim any open issue. `claim()` checks three
things — is it open, is it already claimed, are you the reporter — and never
looks at what the issue is. A report of a downed live cable is as claimable as a
blocked gutter.

This was a known deferral. The auth spec flagged it in the first slice
(§1: a `RESTRICTED` tier "implies vetted or trained volunteers… a credential and
a per-category one at that"), and the claim spec pushed it out explicitly: "Any
citizen who is not the reporter may claim. The `RESTRICTED` eligibility the auth
spec mentions is a later concern." That was reasonable while the loop was being
built. It stops being reasonable the moment real people use this.

## Goal

No ordinary citizen can take on work that needs a specialist, and every issue
that is withheld from them still reaches completion.

Three properties, in priority order:

1. **Fail closed.** Every failure — a timeout, a missing API key, an unparseable
   verdict, an abandoned report — leaves an issue unclaimable, never claimable.
2. **Never silently stuck.** An issue a citizen cannot fix must have a route to
   completion through an agency.
3. **Explainable.** Anyone can be told why an issue was withheld, and who
   decided.

## Non-goals

- **Per-category credentials.** The vetted-volunteer tier the auth spec
  anticipated. `RESTRICTED` here means "not for volunteers", not "for volunteers
  holding certificate X". That remains a later slice, and this design leaves
  room for it: the gate reads one field.
- **Grading danger.** No severity scale. An issue is withheld or it is not.
- **Reporter safety advice.** The platform does not tell a reporter what to do
  about a hazard. It classifies the work, not the emergency.
- **Retrofitting existing issues.** No production data exists. The seed sets
  hazard explicitly.

## Context: what exists today

- `IssueStatus` has eight values and a transition map; `IssueLifecycleService` is
  the single writer of `status`.
- `claim()` sets `volunteerId` to the caller and nothing else can set it. An
  agency cannot assign work, by an earlier decision (self-service first claimer).
- `AGENCY_TARGETS` excludes `RESOLVED` — resolution requires evidence — and
  `CLAIMED`, because that route cannot name a volunteer.
- `IssueVerificationService` calls Claude with `messages.parse` and a zod output
  format, a 60s timeout and one retry, and is off entirely without
  `ANTHROPIC_API_KEY`. A failure records `FAILED` and the work still stands.
- Media uploads derive `purpose` from issue state: `REPORT` while `OPEN` from the
  reporter, `PROOF` while `CLAIMED`/`IN_PROGRESS` from the holder.
- Reporting is two-step: create the issue, then attach media.

## Decisions

**Hazard is a field, not a status.** Status already carries eight values and a
transition map. An issue can be restricted at any point in its life, so folding
this in would multiply the matrix for no gain. The gate reads one field.

**Category does not gate.** An earlier draft made `ELECTRICITY` and
`PUBLIC_SAFETY` automatically restricted. That is wrong: a burnt-out streetlight
is `ELECTRICITY`, and auto-restricting it would block the most ordinary volunteer
job on the platform. Category is context in the prompt, nothing more.

**The model selects questions; it never writes them.** Generated question text
would vary between near-identical reports, occasionally miss the point, and put
unreviewed words in front of someone standing next to a hazard. A curated bank
keeps wording human-written, selection adaptive, answers comparable across
reports, and the output space closed enough to test.

**Answers are closed-form.** Yes / no / not sure. Free text would be
unvalidatable, untestable, and a soft path for injected text into a safety
decision.

**The reporter can escalate but never clear.** Ticked observations force
`RESTRICTED`. Answers can move an unsure verdict either way, but no reporter
input can clear a `RESTRICTED` verdict — only a human can. The reporter is the
one party with a motive to want the gate opened.

**Questions are asked only when the model is unsure.** Always interviewing would
add friction to every report to serve the minority that need it. Asking on low
confidence puts the friction exactly where it buys information, and shrinks the
human queue to the genuinely ambiguous.

## 1. Contracts

`src/contracts/hazard.ts`:

```ts
export enum HazardLevel {
  /** Created, not yet submitted for classification. Never claimable. */
  UNCLASSIFIED = 'UNCLASSIFIED',
  /** Classified as ordinary volunteer work. The only claimable value. */
  UNRESTRICTED = 'UNRESTRICTED',
  /** Needs a specialist. Volunteers are refused; an agency resolves it. */
  RESTRICTED = 'RESTRICTED',
  /** Nobody is confident enough. Waiting on an agency to decide. */
  NEEDS_REVIEW = 'NEEDS_REVIEW',
}

export enum HazardSource {
  REPORTER = 'REPORTER',   // an observation was ticked
  AI = 'AI',
  AGENCY = 'AGENCY',
  ADMIN = 'ADMIN',
}

export const HAZARD_CONFIDENCE_THRESHOLD = 0.7;
export const HAZARD_MAX_QUESTIONS = 5;
export const HAZARD_MIN_QUESTIONS = 3;
```

`src/contracts/hazard-questions.ts` holds the bank: an array of
`{ id, text, tags, askable }`. `askable: false` marks the entries offered as
observation checkboxes at report time; the rest are follow-ups the model may
select. Ids are stable forever — answers are stored against them, and retiring a
question means marking it inactive, never reusing its id.

The initial bank covers electrical, water, traffic, structural, gas and height,
roughly twenty to thirty entries. Drafting it is a task of its own in the plan,
not a side effect of another. **The wording must be reviewed by someone with
field-safety knowledge before launch**; the ids and structure are the
engineering contract, the text is not, and shipping unreviewed wording is the
one part of this design that could do harm on its own.

## 2. Schema

On `Issue`:

```ts
hazard: HazardLevel;               // required, default UNCLASSIFIED, indexed
hazardAssessment?: {
  level: HazardLevel;
  source: HazardSource;
  confidence?: number;             // absent when a human decided
  reasoning?: string;              // the model's, or the human's mandatory reason
  model?: string;
  decidedBy?: Types.ObjectId;      // the human, when source is AGENCY or ADMIN
  assessedAt: Date;
};
observations: string[];            // question ids ticked at report time
answers?: { questionId: string; answer: 'YES' | 'NO' | 'UNSURE' }[];
pendingQuestions?: string[];       // question ids awaiting answers
agencyResolverId?: Types.ObjectId; // the agency user who recorded a fix
```

`hazard` is indexed: `?hazard=NEEDS_REVIEW` is the agency's queue.

Only the hazard service and the hazard route write `hazard`, mirroring the rule
that only `IssueLifecycleService` writes `status`.

## 3. The three steps

**Step 1 — `POST /issues`.** Unchanged except that it accepts
`observations?: string[]`, validated against the bank's checkbox entries. The
issue is created `UNCLASSIFIED`.

**Step 2 — `POST /issues/:id/media`.** Unchanged.

**Step 3 — `POST /issues/:id/classification`.** Reporter only, and only while
`UNCLASSIFIED`. Anyone else is **403**; an issue already carrying a level is
**409**, so a second submission cannot re-roll a verdict the reporter dislikes.
Two phases:

- **First call.** If any observation was ticked, the issue goes straight to
  `RESTRICTED` with source `REPORTER` and no AI call. Otherwise the classifier
  runs over title, description, category and up to two `REPORT` images.
  Photographs are optional: media is not required to report, so a text-only
  report is classified on its text alone. The prompt states whether a photograph
  exists, as fact, but carries no instruction to be more cautious without one.
  A clear description ("live cable down across the road") deserves a confident
  verdict; a vague one will score low on its own merits and take the question
  route. Penalising the absence of a photo twice would only push ordinary
  reports into the human queue.

  The question step earns its keep most here: with no photograph, the reporter
  is the only source of anything the text left out.
  - Confident (≥ 0.7) either way → `UNRESTRICTED` or `RESTRICTED`, done.
  - Unsure → the model selects 3–5 question ids from the bank; they are stored in
    `pendingQuestions` and returned. The issue stays `UNCLASSIFIED`.
  - Error, timeout, or no API key → `NEEDS_REVIEW`.
- **Second call**, with `answers`. Validated against `pendingQuestions` — every
  pending question must be answered, and no others. The classifier runs again
  with the answers included.
  - Confident → `UNRESTRICTED` or `RESTRICTED`.
  - Still unsure, or any error → `NEEDS_REVIEW`.

There is no third round. One set of questions, then a decision or a human.

## 4. IssueHazardService

A sibling of `IssueVerificationService`, sharing its shape: an optional
`Anthropic` client, a resolved threshold, `messages.parse` with
`zodOutputFormat`, `AI_TIMEOUT_MS` and `AI_MAX_RETRIES`.

One parsed schema, returned by a single call — the model gives its verdict and,
in the same breath, the questions it would ask if it had to:

```ts
const Assessment = z.object({
  dangerous: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  questionIds: z.array(z.string()).max(5),
});
```

`questionIds` is read only when the verdict is unsure, so a confident call costs
nothing extra. Ids outside the bank are discarded; if fewer than three survive,
the issue goes to `NEEDS_REVIEW` rather than asking a short list.

The prompt states plainly that the model is deciding whether **a member of the
public without training or equipment** should attempt the work — not whether the
problem is severe. A large but ordinary refuse pile is not dangerous; a small
frayed cable is.

The service never throws. Every failure path returns a `NEEDS_REVIEW` assessment
carrying the reason, and the caller records it.

## 5. Claim gating

In `claim()`, before any other check:

```ts
if (issue.hazard !== HazardLevel.UNRESTRICTED) { throw new ForbiddenException(...) }
```

Three distinct messages, because "you can't do this" is useless to a client:

| `hazard` | Message |
|---|---|
| `UNCLASSIFIED` | This issue has not been classified yet |
| `NEEDS_REVIEW` | This issue is waiting for an agency to review it |
| `RESTRICTED` | This issue needs specialist handling and cannot be claimed |

It goes first so a restricted issue never reports "already claimed" instead.

## 6. Human classification

`PATCH /issues/:id/hazard`, `@Roles(AGENCY, ADMIN)`:

```json
{ "level": "RESTRICTED" | "UNRESTRICTED", "reason": "..." }
```

`reason` is required and capped at 500 characters, like `statusReason`. Agencies
work the `NEEDS_REVIEW` queue and may correct any classification; admins may do
the same and override an agency. Both are recorded in `hazardAssessment` with
`decidedBy`. Citizens are refused by the role guard.

`NEEDS_REVIEW` and `UNCLASSIFIED` cannot be set by hand: a human decision is
always a decision.

## 7. Agency resolution

A restricted issue cannot be claimed, and today that is a dead end — agencies
cannot claim (citizen-only) and cannot set `RESOLVED`. So:

- **Media.** `assertMayAttach` gains a branch: a user holding `AGENCY` may attach
  `PROOF` to a `RESTRICTED` issue while it is `OPEN` or `IN_PROGRESS`.
- **Resolution.** `POST /issues/:id/resolution` accepts an `AGENCY` actor when
  `hazard` is `RESTRICTED`, requiring the same note and at least one proof photo
  by that actor. It sets `agencyResolverId`, not `volunteerId`, and allows
  `OPEN → RESOLVED` for this path only.
- **Verification.** The same AI before/after check runs. An agency's own claim of
  a fix is evidence-checked exactly like a volunteer's.
- **Points.** `awardForVerification` is called only when `volunteerId` is set. An
  agency-resolved issue pays nobody.
- **Anti-self-dealing.** The existing refusal extends: an actor may not confirm an
  issue where they are `volunteerId` **or** `agencyResolverId`.

## 8. API summary

| Route | Who | Effect |
|---|---|---|
| `POST /issues` | CITIZEN | now accepts `observations` |
| `POST /issues/:id/classification` | the reporter | classify, or return questions |
| `POST /issues/:id/classification` (with `answers`) | the reporter | re-classify |
| `PATCH /issues/:id/hazard` | AGENCY, ADMIN | set level with a reason |
| `GET /issues?hazard=NEEDS_REVIEW` | public | the review queue |

`PublicIssue` gains `hazard`, `hazardAssessment` and `pendingQuestions`.
`observations` and `answers` are exposed too: the public record should show what
the reporter said. A restricted issue stays fully visible — transparency is not
what is being withheld, only the claim.

## 9. Configuration

`HAZARD_CONFIDENCE_THRESHOLD`, default 0.7, clamped to 0–1 by the existing
`resolveThreshold` helper. Separate from `AI_CONFIDENCE_THRESHOLD`: these are
different judgements and must be tunable apart.

Without `ANTHROPIC_API_KEY` there is no fail-open switch. Classification returns
`NEEDS_REVIEW` and a human decides — correct behaviour, not a degraded mode. The
seed sets hazard explicitly so the demo works without a key, and the README says
so plainly.

## 10. Testing

Unit:

- The decision table, every row, with the client stubbed: ticked observation,
  confident-safe, confident-dangerous, unsure-then-questions, unsure-after-answers,
  error, no key.
- Question selection: ids outside the bank discarded; fewer than three survivors
  becomes `NEEDS_REVIEW`.
- Answer validation: missing an answer, answering an unasked question, answering
  when nothing is pending.
- Claim refused at each non-`UNRESTRICTED` level, with the right message, before
  the already-claimed check.
- `PATCH /hazard`: reason required, `NEEDS_REVIEW` rejected as a target, citizen
  refused, `decidedBy` recorded.
- Agency resolution: proof required, `agencyResolverId` set, no points awarded,
  the resolver cannot confirm.

E2E: the whole three-step report; a restricted issue refusing a claim, then
resolved by one agency user and confirmed by a second, reaching `VERIFIED` with
no ledger entry written; the first agency user refused when they try to confirm
their own fix; the `NEEDS_REVIEW` queue.

The generated content is not asserted — only that 3–5 valid ids come back and
that the answers reach the second call.

## 11. Risks

| Risk | Mitigation |
|---|---|
| The model clears something genuinely dangerous | Confident-safe is the only auto-clear, the reporter's checkboxes override it, and an agency can restrict it afterwards. Residual risk is real and cannot be engineered to zero. |
| Reporters abandon at the question step | The issue stays `UNCLASSIFIED` and unclaimable, which is safe but invisible. No sweep job in this slice; noted as a gap. |
| A reporter answers dishonestly to unblock an issue | Answers cannot clear `RESTRICTED`; they are stored and attributed; the reporter cannot claim their own issue. |
| The bank has no question for an unanticipated hazard | The model can still flag danger directly, and anything unresolved becomes `NEEDS_REVIEW`. |
| Two AI calls per unsure report | Only on unsure reports; the confident path is one call, and a ticked observation is none. |
| Question wording is wrong or alarming | Human-written and reviewed before launch; ids are stable so a question can be retired on evidence. |

## Definition of Done

- A citizen cannot claim any issue that is not `UNRESTRICTED`.
- A report passes through create → media → classification, and receives either a
  level or 3–5 questions drawn from the bank.
- Every AI failure yields `NEEDS_REVIEW`.
- An agency can take a `RESTRICTED` issue to `VERIFIED` with evidence, paying
  nobody, and cannot confirm its own fix.
- An agency can classify the `NEEDS_REVIEW` queue; an admin can override.
- `npm test`, `npm run test:e2e`, `npm run build` and `npm run lint` all pass;
  the README and the frontend guide describe the three-step flow.
