# CiviCon — submission summary

**Project:** CiviCon, a trusted civic-action platform. Citizens report local
problems; other citizens fix them; the fix is verified before anyone is
credited.

**Track:** _[FILL IN — the track this is submitted under]_

**Repository:** NestJS 12 backend (ESM, TypeScript, MongoDB/Mongoose 9),
108 commits, 383 unit tests and 112 end-to-end tests passing.

---

## What it does

A citizen reports a problem with photographs. Before anyone may touch it, the
report is classified for danger — a live cable is not volunteer work. Ordinary
issues can be claimed by any other citizen, who fixes the problem and submits
photographic proof. An AI compares the before and after images and forms a view.
An agency then confirms, and only then are civic points awarded.

The core idea is that **verification, not reporting, is the bottleneck**.
Report-a-problem apps have existed for years; what stops citizens being paid or
trusted to fix things is that nobody can cheaply check the work was done. Making
a fix verifiable is what makes everything else possible.

## Information sources

The project began from a **Trusted Civic Action Platform execution guide**,
which shaped the first slice: the phase structure, the actor roles, and the
early data model. That guide became unavailable after the authentication slice.

Everything from the second slice onward was derived from first principles plus
the hints the first spec had preserved — `reportedBy` versus `volunteerId` for
anti-self-dealing, an eligibility/lock/assignment model for claims, and
`civicPointsCached` as a cache over a `point_transactions` ledger. This is
recorded in the specs rather than hidden: the issue-reporting design states
plainly that the guide is unavailable, that the design is derived, and that
**where the guide resurfaces and disagrees, it wins**. Divergences known at the
time are argued explicitly — for example, the deliberate absence of a
`VOLUNTEER` role, which diverges from guide §4.1 because volunteering is an
action a citizen takes, not an identity they hold.

Technical questions were answered from primary sources rather than recollection:
MongoDB's own documentation on the 16 MB BSON limit when choosing GridFS for
media; the installed Anthropic SDK's type definitions to confirm the API accepts
images but not video, which is why video proof is handled by extracting frames.
Framework behaviour was checked against the installed packages — the two
different HTTP 413 responses an oversized upload can produce, for instance, were
found by reading the multipart handler, not assumed.

**There was no user research, no market data and no pilot.** Nothing in this
submission claims otherwise.

## Approach to trust and accuracy

Trust is the product, so the design choices are mostly about withholding
authority rather than granting it.

**Nothing the client says about itself is believed.** `reportedBy`, `status`,
and whether a photograph counts as evidence are all derived server-side from the
authenticated caller and the issue's state. A payload carrying them is rejected
as an unknown field, so there is no gate to get wrong.

**Each piece of state has exactly one writer.** Status belongs to the lifecycle
service; hazard belongs to the classification service. The one deliberate
exception — an edit withdrawing a clearance — is documented where it lives and
can only ever move the value back to "unclassified", never assign a level.

**The AI recommends; it never pays.** A confident AI approval parks the issue in
its own state and awards nothing. A human at an agency must confirm before any
points are written. The model can approve but never reject: a confident "not
fixed" goes to a human, because a false negative would cost a volunteer their
credit on a model's say-so.

**The safety gate fails closed.** Every failure of hazard classification — a
timeout, an unreadable verdict, a missing API key, too few usable questions —
leaves the issue unclaimable and queued for a person. There is no path from any
failure to "safe to claim". When the model is unsure it asks the reporter three
to five questions drawn from a curated bank, so the wording shown to someone
standing next to a hazard is human-written rather than generated.

**Nobody signs off their own work.** A citizen cannot claim an issue they
reported, and cannot confirm work they did — including a user holding both
citizen and agency roles, and including an agency that resolved a restricted
issue itself.

**The points ledger is append-only.** A reversal is a negative entry, never a
deletion, so the history is always readable, and a unique index makes a repeated
award a no-op rather than a double payment.

**Accuracy of the work itself** was pursued by making claims checkable. Each
slice went design document → implementation plan → implementation, with every
task independently reviewed before the next began, and a whole-branch review at
the end. Those reviews found real defects, not cosmetic ones: a classification
that could throw instead of failing closed, a payment predicate that would have
paid a volunteer who did no work, a media permission that let an agency delete a
reporter's evidence, and a path that let a cleared issue be silently rewritten
into a dangerous one. Each was fixed and re-reviewed.

Documentation was audited the same way — routes, error messages and validation
limits extracted from the source and compared against the text, which caught a
frontend guide that documented six of twenty-six safety questions and would have
left a client unable to render the rest.

**What is deliberately not claimed.** The confidence threshold has not been
validated against real photographs at scale. There is no rate limiting. Agencies
are a role, not an organisation, so any agency user can act on any issue. The
first administrator can only be created by the seed. Most importantly, **the
safety questions have not been reviewed by anyone with field-safety knowledge** —
they are the one part of this system that could do harm on its own, and that
review is a launch blocker. All of these are written into the specs and the
README as known gaps rather than left to be discovered.

## Use of AI tools

AI was used heavily and in two distinct roles.

**As a development environment.** The project was built with Claude Code
(Claude Opus 5) throughout — design dialogue, written specifications,
implementation, and review. Implementation ran through a subagent workflow: a
fresh agent per task working only from a written brief, an independent reviewer
for each task's diff, and a whole-branch review before merge. Keeping the
reviewer separate from the implementer mattered; most of the defects listed
above were found by a reviewer reading a diff, not by the agent that wrote it.
Decisions taken without the author present were recorded as explicit rulings
with their cost if wrong.

**As a runtime component.** Claude Opus 5 performs two jobs in the product
itself: comparing before-and-after photographs to judge whether a reported
problem was fixed, and screening a new report for danger before anyone may claim
it. Both are bounded — a timeout, a single retry, at most two images per side —
and both are advisory: each has a human decision behind it.

Where AI output is shown to people, it is constrained rather than trusted. The
model selects safety questions from a fixed bank by id; it never writes the
wording a reporter reads. Reporter-supplied text is passed to the model inside
an explicit boundary and named as untrusted data, so a report cannot instruct
the classifier.

The honest limitation is the same one named above: a model wrote the first draft
of the safety questions, and a human with the right expertise has not yet read
them.
