# Goals Coach Phase 2: backend foundation and operating contract

Status: local implementation prepared for review. It is not committed, deployed, migrated, or member-facing.

## Runtime contract

Phase 2 supports Node `>=20.9.0 <21`; the reviewed build and test runtime is Node **20.19.5**. Railway must be explicitly confirmed to use an approved Node 20 runtime before deployment. The package must not be deployed on the repository's former Node 18 baseline or on an unreviewed newer major.

## Product and release boundaries

Goals Coach exists to help people succeed—not to impress them. It should leave members more confident, capable, informed, and hopeful. It extends the relationship with a human coach and should build independence rather than dependence.

This feature is ongoing coaching, not a support chat. Member language must not use “support chat,” “ticket,” “case,” “flag created,” “issue logged,” or “escalation.” The entry-point copy remains:

> Questions about your workout or your progress? Check in with Goals Coach anytime. Your coach can review the conversation whenever needed.

Phase 2 establishes authentication, authorization, ownership, storage, and review workflow only. It does not implement the Goals Coach model or substitution engine. Production message submission returns `503 COACHING_NOT_READY` and writes nothing.

The Phase 4 member interface may be built later, but it must not be piloted, activated, or released until the protected Phase 5 Coaching Review interface is functional and tested. Any priority or urgent review must have a secure, actionable staff destination before members can use the feature. Member-facing production activation is also blocked until the coaching-data retention and deletion policy is approved.

## Ownership and immutability model

PostgreSQL enforces all relationships that can be represented from the current repository schema:

- `coach_plans` gains `UNIQUE (id, member_id)`.
- `weekly_checkins` gains `UNIQUE (id, member_id)`.
- A conversation’s `(plan_id, member_id)` references one plan owned by that member.
- A message’s `(conversation_id, member_id)` references one conversation owned by that member.
- A concern’s conversation, member, plan, and source member message are one composite relationship.
- A review’s concern, member, conversation, and plan are one composite relationship.
- An observation or milestone source message/check-in/conversation must belong to the same member.
- A proposal’s member, conversation, source plan, member request message, and optional source exercise are mutually consistent.

The existing saved plan is JSON/Markdown and has no stable per-exercise key. Phase 2 therefore creates `coach_plan_exercises` but does not silently transform existing plan data. Until a reviewed projection/backfill process exists, `source_plan_exercise_id` remains nullable. When present, its composite foreign key enforces the source plan. When absent, the conversation/source-plan/member relationship remains database-enforced, and Phase 3 must perform a locked transactional validation before creating a proposal.

Messages and review events are append-only at the Phase 2 application layer. No runtime update or delete routes exist for either table. The migration does **not** claim PostgreSQL permission- or trigger-enforced immutability for those two tables. Production database roles should be narrowed in a later reviewed hardening step if database-level append-only permissions are desired.

Coach assignments are stronger: PostgreSQL rejects deleting assignment history and rejects ending an assignment while that coach owns an `assigned` or `in_review` review for the member.

No existing row is rewritten or deleted by the migration.

## Phase 2 tables

| Table | Purpose | Key rules |
|---|---|---|
| `staff_users` | PostgreSQL authorization for Clerk identities | `UNIQUE (auth_provider, auth_subject)`; provider is `clerk`; inactive by default; `coach` or `admin` |
| `member_coach_assignments` | Active/historical coaching ownership | One active primary coach per member; no duplicate active coach/member pair; admin-created; no deletion |
| `coach_plan_exercises` | Stable exercise references and coaching intent | Unique plan item; pattern, goal, muscles, phase, role, equipment, limitation considerations, program-balance tags, prescription, explicit intent source/evidence, and `unknown`/`unreviewed` validation states; no Phase 2 backfill |
| `coaching_conversations` | Ongoing member/plan thread | Member-plan composite FK; one active conversation per member/plan; archive, never delete |
| `coaching_messages` | Member, Goals Coach, and staff messages | Member/conversation composite FK; client UUID idempotency; application-layer append-only |
| `coaching_concerns` | Structured discomfort, safety, or practical concern | Source must be a member message in the same conversation/member/plan |
| `coaching_reviews` | Actionable staff Coaching Review | Auto-assigned to active primary coach or left unassigned; one review per concern |
| `coaching_review_events` | Review audit timeline | Composite review/member FK; application-layer append-only |
| `coaching_observations` | Non-medical coaching memory | Explicit message, weekly check-in, or staff provenance; no `plan_result` source |
| `coaching_milestones` | Grounded meaningful wins | Explicit message, weekly check-in, or staff provenance; confirmation fields enforced |
| `coaching_plan_change_proposals` | Proposed permanent change and review decision | Member request message only; immutable source plan; no apply/revision route |
| `app_schema_migrations` | Migration checksum ledger | Created by the runner; migration version/checksum is immutable by convention |

## Provenance lifecycle

`coaching_observations` and `coaching_milestones` use explicit nullable columns:

- `source_message_id`
- `source_conversation_id`
- `source_weekly_checkin_id`
- `source_staff_user_id`

Their CHECK constraints permit exactly one source shape:

| `source_type` | Required | Must be null |
|---|---|---|
| `member_message` | message + conversation | weekly check-in + staff user |
| `weekly_checkin` | weekly check-in | message + conversation + staff user |
| `staff` | conversation + staff user | message + weekly check-in |

`member_message` also stores `source_message_sender_type = 'member'` and uses the composite message/conversation/member/sender foreign key. PostgreSQL therefore rejects Goals Coach or staff messages as member-message provenance.

`plan_result` is unavailable in Phase 2.

Observation lifecycle: `candidate → active/confirmed → superseded/retired/expired`. A candidate is not treated as durable truth. Conflicting or time-sensitive observations are superseded or retired; medical diagnoses are never stored as coaching observations.

Milestone lifecycle: `recorded → confirmed → superseded/withdrawn`. A milestone must come from an explicit member report, saved weekly check-in, or staff record in Phase 2. Confirmation records the staff user and time. Goals Coach must never infer, invent, or overstate a milestone.

## Staff authentication and origin security

Clerk Pro authenticates staff identity; PostgreSQL authorizes every request. Members remain on the existing GymMaster verification flow and do not become Clerk users.

Required Railway variable names for a later approved deployment:

- `CLERK_SECRET_KEY`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_ISSUER`
- `CLERK_AUTHORIZED_PARTIES_PRODUCTION`
- `CLERK_AUTHORIZED_PARTIES_DEVELOPMENT`

The authorized-party variables are comma-separated **exact origins**. Production and development lists are selected exclusively by `NODE_ENV`; they are not merged. Wildcards, regexes, paths, trailing slashes, and non-HTTPS production origins are refused.

Phase 2 uses audience approach B: no `CLERK_JWT_AUDIENCE` variable and no audience check. A browser-provided audience is never accepted. If a custom Clerk session-token `aud` claim is configured later, adding an audience check requires a separate reviewed change.

The middleware:

1. Accepts only `session_token`.
2. Uses Clerk to validate instance/key, issuer cryptographically, signature, expiration, and token type.
3. Requires authenticated subject and session identifiers.
4. Requires `azp` and validates it through Clerk `authorizedParties` plus an explicit local exact-list check.
5. Validates `iss` against `CLERK_JWT_ISSUER` and `exp` again before authorization.
6. Performs an uncached lookup of `(auth_provider, auth_subject)` in `staff_users` on every request.
7. Rejects missing/inactive staff records immediately.

Staff browser requests additionally pass a separate actual-`Origin` guard before the existing member CORS middleware. Approved OPTIONS requests receive exact-origin CORS headers and `204`; unexpected or missing preflight origins fail closed. Non-browser requests may omit `Origin`, but their token still requires a valid `azp`. The existing member CORS allowlist and regex behavior is unchanged for non-staff routes.

No Clerk token, secret key, or subject is logged. Secret keys are server-only and must never enter `NEXT_PUBLIC_*` configuration.

### Required Clerk dashboard policy (manual, later)

- Invite-only staff access; public registration disabled.
- MFA required.
- Multi-session disabled.
- Inactivity timeout: 30 minutes.
- Maximum session lifetime: 8 hours.
- Only approved production/development staff origins configured.

Clerk session JWTs are short-lived (normally about 60 seconds). Logout, session revocation, or Clerk account disabling may leave an already issued token cryptographically valid until it expires; tests must verify the configured Clerk behavior once an application exists. `staff_users.active = false` is authoritative and blocks the next API request immediately because authorization is not cached. Offboarding order is PostgreSQL deactivation first, then Clerk session/account revocation.

## Safe staff provisioning

`npm run provision:staff -- --subject <immutable-clerk-subject> --email <email> --display-name <name> --role <coach|admin> [--activate]`

- The immutable Clerk `user_...` subject is required and validated.
- Unknown, token-, secret-, password-, or key-like arguments are refused.
- New staff records are inactive unless `--activate` is explicitly present.
- An email already mapped to a different provider/subject is refused.
- Re-running the exact mapping is idempotent and never deactivates an active record.
- Confirmation output contains only operation, internal staff ID, provider, role, and active status.
- The script never calls Clerk and never accepts or prints a Clerk token or secret.

Use `display_name` as the approved member-facing short name (for example, `Derek`). Member-facing language may produce “Coach Derek” only when an active primary assignment joins to that staff record. Without that database-backed ownership, the API returns “one of our coaches.” Browser input and model output never select the name.

## Exact member API contracts

All member routes require the existing `Authorization: Bearer <membership-verification-JWT>`. The authenticated JWT `sub`, not a browser member ID/name, resolves `coach_members.gymmaster_member_id`.

### `POST /goals-coach/session`

Request body: none.

`200`:

```json
{
  "conversation": {
    "id": "101",
    "planId": "55",
    "status": "active",
    "openedAt": "2026-07-15T20:00:00.000Z",
    "archivedAt": null,
    "updatedAt": "2026-07-15T20:00:00.000Z"
  },
  "plan": { "id": "55", "savedAt": "2026-07-10T18:00:00.000Z" },
  "coach": { "displayName": "Derek", "reference": "Coach Derek" }
}
```

With no active primary coach, `coach` is `{ "displayName": null, "reference": "one of our coaches" }`. The latest saved plan is used. Existing active member/plan conversation creation is idempotent.

### `GET /goals-coach/conversations?limit=50&cursor=<opaque>`

`200`: `{ "conversations": [<conversation objects>], "nextCursor": "opaque-or-null" }`. Limit is 1–100. Results are newest first; pass `nextCursor` unchanged to retrieve the next older page.

### `GET /goals-coach/conversations/:conversationId/messages?limit=50&cursor=<opaque>`

`200`:

```json
{
  "conversationId": "101",
  "messages": [{
    "id": "501",
    "conversationId": "101",
    "senderType": "member",
    "content": "What does 3 sets of 10 mean?",
    "structuredResponse": null,
    "createdAt": "2026-07-15T20:01:00.000Z"
  }],
  "nextCursor": "opaque-or-null"
}
```

Messages are newest first so the first request returns recent context; the cursor retrieves older pages without duplicates or gaps. Cross-member access returns `404 CONVERSATION_NOT_FOUND`.

### `POST /goals-coach/conversations/:conversationId/messages`

Phase 2 production behavior is unconditional after member authentication. Every body, header, query, and environment configuration receives:

`503`:

```json
{
  "error": "COACHING_NOT_READY",
  "message": "Goals Coach ongoing conversations are not available yet."
}
```

No message, concern, review, observation, milestone, or proposal is written. A deterministic responder can enter only through test-application dependency injection; production startup does not import it.

### `POST /goals-coach/conversations/:conversationId/close`

Request body: none.

Ownership is verified from the member JWT. Messages/history remain. Active becomes archived; archived/superseded requests return their existing final state, making the operation idempotent.

`200`:

```json
{
  "conversationId": "101",
  "status": "archived",
  "archivedAt": "2026-07-15T20:30:00.000Z"
}
```

Errors: `401` invalid membership token; `404 CONVERSATION_NOT_FOUND`; `404 COACHING_PROFILE_NOT_FOUND`.

## Exact staff API contracts

Every route requires the exact staff Origin policy, valid Clerk session token/`azp`, and active matching `staff_users` record.

- `GET /staff/session` → `{ "staffUser": { "id", "displayName", "role" } }`.
- `GET /staff/coaching-reviews?queue=all|mine|unassigned&limit=50&cursor=<opaque>` → `{ "reviews": [...], "nextCursor": "opaque-or-null" }`. Cursor order is stable by priority, creation time, and ID. Coaches receive only reviews assigned to them where their member assignment remains active. `unassigned` is admin-only.
- `GET /staff/coaching-reviews/:reviewId` → `{ "review": {...}, "events": [...] }`. A coach needs both assignment to the review and active coverage of the member; admins can access all.
- `PATCH /staff/coaching-reviews/:reviewId` body `{ "action": "assign"|"reassign", "staffUserId": "9" }` is admin-only. A coach assignee must actively cover the member; an active admin may accept an unassigned review without a coach assignment.
- `PATCH /staff/coaching-reviews/:reviewId` body `{ "action": "start" }` requires an assigned review and access.
- `PATCH /staff/coaching-reviews/:reviewId` body `{ "action": "complete_follow_up", "resolutionNote": "..." }` completes a required member follow-up in the review and linked concern in one transaction.
- `PATCH /staff/coaching-reviews/:reviewId` body `{ "action": "resolve"|"no_action_needed", "resolutionNote": "..." }` requires access and a nonempty note.
- `POST /staff/coaching-conversations/:conversationId/messages` body `{ "content": "...", "clientMessageId": "UUID" }` appends a staff message after member-coverage authorization. Concurrent retries with the same UUID/content return the original message and do not duplicate the review event; reuse with different content is rejected.
- `POST /staff/member-coach-assignments` body `{ "memberId", "staffUserId", "assignmentType": "primary"|"secondary" }` is admin-only.
- `PATCH /staff/member-coach-assignments/:assignmentId` body `{ "action": "end" }` is admin-only and fails until open reviews owned by that coach are reassigned or resolved.
- `PATCH /staff/coaching-observations/:recordId` accepts only `activate`, `confirm`, `correct`, `supersede`, or `retire`. Correction creates a new staff-provenanced row and supersedes the original; history is preserved.
- `PATCH /staff/coaching-milestones/:recordId` accepts only `confirm`, `correct`, `supersede`, or `withdraw`. Confirmation identity/time and correction provenance are preserved.
- `PATCH /staff/plan-change-proposals/:recordId` accepts only `approve`, `reject`, or `withdraw` from `proposed`; it never changes `coach_plans`.

Unauthorized access to a specific member-owned review, conversation, observation, milestone, or proposal returns a concealed `404`. General role failures, including coach access to admin-only queues or assignment operations, remain `403`.

The new route families use independent member/staff rate limiters keyed to authenticated identity. Session creation and conversation close have a deliberately tighter shared member limit to prevent repeated close/reopen cycles. These limiters do not alter the existing verification/onboarding limits or Railway's one-hop trust-proxy setting.

There is no `POST /staff/plan-change-proposals/:proposalId/apply` and no route that creates a replacement `coach_plans` row. There are no message or review-event update/delete routes.

## Frozen Phase 3 structured response contract

This contract is documented for compatibility but is not generated or validated by production Phase 2:

```json
{
  "acknowledgement": "string or null",
  "education": {
    "summary": "short conversational explanation",
    "whyItMatters": "string or null"
  },
  "recommendation": {
    "action": "string",
    "temporary": true,
    "reason": "string"
  },
  "instruction": {
    "setup": "short plain-English setup",
    "cues": ["cue one", "cue two"],
    "commonMistake": "string",
    "regressionOrAlternate": "string",
    "stopRule": "string"
  },
  "safetyAction": "none | clarify | stop_exercise | staff_review | urgent_guidance",
  "nextQuestion": "one nullable string",
  "staffReview": {
    "required": false,
    "priority": "routine | priority | urgent | null",
    "memberWording": "natural human wording or null"
  }
}
```

Goals Coach may ask no more than one question. One thoughtful question is required only when clarification is necessary or genuinely helps. No question is required for a complete educational answer, clear next action, complete instruction, natural ending, or urgent guidance.

When understanding is incomplete, it asks one clarifying question rather than guessing about symptoms, exercise identity/purpose, equipment, limitations, or the meaning of pain/discomfort.

## Frozen deterministic safety matrix

| Input state | Phase 3 action | Review |
|---|---|---|
| Meaning of discomfort unclear | Acknowledge; ask one clarifier distinguishing pain, pressure, fatigue, instability, fear, or technique confusion | None until clarified unless concerning language already exists |
| Sharp, severe, unusual, worsening, or radiating pain; numbness; tingling; unexplained weakness | Persist privacy-safe concerning-signal keys, set `stop_exercise`, tell member to stop; no routine substitution; appropriate coach/healthcare guidance | Caution, priority, or urgent as deterministically applicable |
| Emergency/urgent symptom pattern | Immediate appropriate urgent-care/emergency guidance; no coaching continuation question required | Urgent and actionable |
| Normal fatigue/soreness with no red flags | Brief education, recovery/practical adjustment, clear stop rule | Routine only when follow-up is useful |
| Equipment/skill/comfort issue with no red flag | Clarify first; preserve exercise purpose; temporary alternative | Review if persistent/permanent change is requested |
| Healthcare restriction | Never contradict; stay inside documented restriction | Staff review when plan fit is uncertain |

Substitutions must preserve movement pattern, training goal, muscle groups, workout phase, program role, equipment availability, member limitations, and program balance. Phase 2 stores those intent fields but performs no substitutions.

## Coaching Review ownership workflow

1. A concern transaction creates the review.
2. The active primary coach is selected from PostgreSQL. If present and active, the review is assigned automatically; otherwise it remains unassigned.
3. Coaches cannot claim unassigned work. They see only reviews assigned to them for members they actively cover.
4. Admins manage the shared unassigned queue and may assign/reassign it. A coach target must actively cover the member; an active admin may take an unassigned review.
5. Start, assignment, reassignment, staff response, and completion are visible through messages/review events as implemented.
6. Reviews and concerns store explicit member-follow-up state. Required follow-up cannot be falsely marked complete and a review cannot resolve while it remains pending. Starting/completing a review and completing follow-up synchronize the linked concern in the same transaction.
7. Reviews require a resolution note.
8. Assignment/reassignment locks and validates the active member-coach assignment; assignment termination locks the assignment row. Together with the named database trigger, either race order leaves a valid deterministic state rather than a review assigned to an ended coach.

## Migration, rollback, and deployment order

No production command has been run.

1. Review/approve this diff.
2. Create Clerk application manually and configure the frozen security settings.
3. Provision the first admin **inactive**; verify subject mapping; explicitly activate.
4. Add exact Railway variables in an approved maintenance window.
5. Take a PostgreSQL backup and verify `migration_001` tables/columns through catalog queries. Abort on any mismatch; never rewrite rows to force a constraint.
6. Deploy code with staff routes fail-closed and member message route still `503`.
7. Run `npm run migrate:phase2` once. It uses an advisory lock, transaction, checksum ledger, and no row rewriting.
8. Smoke-test existing health, verification, onboarding, plans, weekly check-ins, cron protection, Zapier safeguards, member CORS, and Railway proxy behavior.
9. Test Clerk MFA/login/logout/expiration/disable and PostgreSQL deactivation.
10. Keep the member feature unreleased until Phase 5 and retention gates pass.

Rollback requires `CONFIRM_PHASE2_ROLLBACK=YES npm run rollback:phase2`. It refuses to run when a later recorded migration exists. The rollback drops only Phase 2 objects and the two additive composite unique constraints; it preserves existing member, plan, and weekly-check-in rows. Before production rollback, stop writes to Phase 2 routes and export Phase 2 data if it must be retained.

## Test strategy and responsibility split

Automated tests run with `npm test` against disposable PGlite and embedded PostgreSQL 16 engines. The real PostgreSQL concurrency cases must run as an unprivileged OS user because PostgreSQL refuses root startup. Coverage includes migration/checksum/rollback, composite ownership, true member-message provenance, lifecycle transitions, linked concern/review follow-up state, stable cursor pagination, scoped rate limiting, production `503` no-write behavior, staff-message idempotency, concurrent session/message/assignment behavior, exact Origin/CORS behavior, Clerk claim failure modes, immediate PostgreSQL deactivation, provisioning, concealed cross-member resources, absent mutation/apply routes, and existing-route regression markers.

`npm run check` runs `node --check` on every JavaScript file, including `server.js`.

Development chat can prepare code, migration, tests, scripts, lockfile, documentation, diffs, and local/disposable verification. Sintra may later implement Clerk frontend integration and the Phase 4/5 interfaces only from approved contracts; it must not change backend authorization or coaching logic. The owner must manually create/configure Clerk, invite staff, confirm immutable subjects, set Railway secrets/origins, approve/run production migration, validate deployment, and approve retention and release gates.
