# AGENTS.md

## Project

This repository is the backend for Goals Coach. Preserve its member-safety, authentication, authorization, privacy, provenance, isolation, and data-integrity requirements.

- Use Node.js `>=20.9.0 <21`.
- Treat PostgreSQL migrations and integrations with GymMaster, Clerk, OpenAI, and Railway as sensitive boundaries.
- Keep secrets in environment configuration only. Never add `.env`, credentials, production identifiers, or member data to the repository.
- Preserve fail-closed behavior and disabled-by-default capabilities.
- Deterministic test adapters must remain test-only and must not be imported by production startup or source.

## Normal development

Before changing anything:

1. Inspect the repository structure, relevant documentation, current branch, HEAD, and working-tree status.
2. Identify existing user changes and preserve anything outside the approved scope.
3. Confirm that implementation has been authorized.

Never work directly on `main`. After implementation is authorized, create an appropriately named `feature/...` or `fix/...` branch before editing.

During implementation:

- Make the smallest change needed for the approved scope.
- Follow repository-native JavaScript, service-composition, migration, and test patterns.
- Preserve API contracts, error concealment, exact ownership checks, immutable provenance, rate limits, and feature-gate defaults.
- Do not rewrite or weaken safeguards merely to make a test pass.
- Use `npm ci` for a clean dependency installation when installation is authorized.
- Prefer focused tests first, using Node’s test runner with serial execution, for example:
  `node --test --test-concurrency=1 test/<focused-file>.test.js`
- After focused tests pass, run broader relevant tests, then `npm test` and `npm run check` when appropriate and authorized.
- Real PostgreSQL tests use embedded PostgreSQL 16 and must run as an unprivileged OS user. A root skip is not acceptance evidence.
- Do not claim success when relevant tests failed or were skipped.

At handoff, report:

- files changed;
- tests and checks run, including failures or skips;
- remaining risks or unverified behavior;
- current branch; and
- current Git status.

## Mandatory owner approval

Do not perform any of the following without Derek Cook’s explicit approval for the exact action:

- commit;
- push;
- create or update a pull request;
- merge;
- deploy;
- run a database migration or rollback;
- access or modify production data;
- change Railway configuration or environment variables;
- enable or disable feature flags;
- contact GymMaster, Clerk, OpenAI, Railway, or another live provider;
- perform a real member login or enrollment;
- send messages or expose member information; or
- run destructive Git, database, filesystem, or infrastructure operations.

Implementation approval does not authorize any item above.

## Production safety

- Default to local, offline, disposable, and synthetic testing.
- Never infer production authorization from implementation, review, test, deployment, or migration authorization.
- Treat deployment, migration, configuration, feature activation, live-provider access, and member testing as separate approval gates.
- Before an authorized external action, restate the exact target, environment, command or operation, and expected effect.
- Afterward, verify the result and report concrete evidence.
- Never print, commit, log, transmit unnecessarily, or expose secrets, tokens, cookies, credentials, personal information, transcripts, raw audio, provider payloads, or member health information.
- Keep production feature flags disabled unless their exact activation is separately approved.
- Never treat a readiness report, approval-record draft, successful deployment, healthy service, completed migration, or configured provider as authorization to activate a feature.
- Preserve transactional migrations, advisory locking, migration ordering, checksum validation, guarded rollback behavior, and existing data. Never alter data merely to force a migration or constraint to pass.

## Goals Coach behavioral safety

- Deterministic safety screening and safety-stop behavior override plan generation and ordinary conversation flow.
- Current pain, sharp pain, concerning symptoms, instability, weakness, numbness, tingling, restrictions, or ambiguous discomfort must not be silently treated as safe.
- Preserve one-question-at-a-time coaching, movement before intensity, form before weight, and member dignity.
- When important information is unclear, ask one focused question rather than guessing.
- Safety responses must not mutate workout state or falsely claim that a human received a review.
- Persist only the minimum privacy-safe safety classification and provenance required by the existing contract.
- Do not weaken safety, authentication, authorization, provenance, member isolation, timeout, cancellation, concurrency, idempotency, rate limiting, or error-concealment guarantees merely to make a test pass.
- Unknown, unauthorized, or cross-member resources must continue to use the repository’s concealed-error patterns.

## Independent review

- Keep implementation and independent review logically separate.
- A reviewer must inspect the diff, relevant source, tests, documentation, and execution evidence independently.
- A reviewer must not rely only on the implementing agent’s summary or claims.
- Do not represent work as reviewed, approved, accepted, production-ready, deployed, or safe to activate unless the authorized reviewer or Derek Cook actually made that determination.
- When an independent review is complete and ready to hand back to the implementation thread, put `GOALS_COACH_REVIEW_COMPLETE` on its own line in the final reviewer message. Use that marker only for a completed review, never for interim progress, questions, or an unfinished review.

## Windows

- Keep user-facing commands compatible with Windows PowerShell when instructions are intended for Derek.
- Do not assume Bash syntax in local instructions unless clearly labeled for CI or another Unix environment.
- Account for CRLF/LF differences when tests, migration checksums, snapshots, or other exact hashes depend on raw bytes.
