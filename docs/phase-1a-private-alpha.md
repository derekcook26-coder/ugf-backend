# Goals Coach 2.0 Phase 1A private-alpha foundation

Status: local implementation prepared for review. It is not deployed, activated, migrated in production, or approved for Phase 1B.

## Runtime and phase boundary

Use Node `>=20.9.0 <21`. The alpha is server-disabled unless `GOALS_COACH_ALPHA_ENABLED` is exactly `true`. A deployment, migration, healthy service, or Clerk setup does not authorize activation.

The existing `/goals-coach/.../messages` route remains fail-closed with `503 COACHING_NOT_READY`. Phase 1A adds only `/alpha/goals-coach/...` routes. Real AI coaching, voice providers, safety routing, reviewer functionality, public registration, and public access are absent.

The deterministic Phase 1A responder is located under `test/helpers`. Production startup and production modules do not import it. Normal startup returns `503 ALPHA_TEST_RESPONDER_NOT_AVAILABLE` without storing a message.

## Secret-free configuration inventory

| Variable | Visibility | Requirement |
| --- | --- | --- |
| `GOALS_COACH_ALPHA_ENABLED` | server | Defaults false; exact `true` is required for any alpha route. |
| `GOALS_COACH_ALPHA_ENVIRONMENT` | server | One of `test`, `development`, `staging`, or `private_alpha`; stored with consent and feedback. |
| `GOALS_COACH_ALPHA_CONSENT_VERSION` | server | Must exactly equal `GC-ALPHA-CONSENT-1.0`. |
| `GOALS_COACH_ALPHA_ORIGIN` | server | One exact HTTPS production origin; no path, trailing slash, pattern, or wildcard. |
| `GOALS_COACH_ALPHA_DEVELOPMENT_ORIGINS` | server | Comma-separated exact HTTP/HTTPS nonproduction origins. Never merged with production. |
| `GOALS_COACH_MEMBER_CLERK_SECRET_KEY` | protected server secret | Dedicated member-Clerk secret; never browser visible. |
| `GOALS_COACH_MEMBER_CLERK_PUBLISHABLE_KEY` | server | Dedicated member-Clerk publishable key used by backend token verification. |
| `GOALS_COACH_MEMBER_CLERK_ISSUER` | server | Exact dedicated Clerk issuer. |
| `GOALS_COACH_MEMBER_CLERK_AUDIENCE` | server | Exact fixed session-token audience. The claim is mandatory. |

Provisioning additionally uses `DATABASE_URL`, `PGSSLMODE`, `GOALS_COACH_PROVISION_ACTION`, `GOALS_COACH_PROVISION_MEMBER_ID`, `GOALS_COACH_PROVISION_AUTH_PROVIDER`, `GOALS_COACH_PROVISION_AUTH_SUBJECT`, `GOALS_COACH_PROVISION_VERIFIED_EMAIL`, `GOALS_COACH_PROVISIONING_REFERENCE`, `GOALS_COACH_PROVISION_ACTIVATE`, and, for deactivation, `GOALS_COACH_PROVISION_DEACTIVATION_REASON`. Inputs are accepted only through the protected process environment, never command-line arguments.

No approved email, authentication subject, member ID, provider credential, or production origin is committed.

## Dedicated Clerk manual-configuration procedure

Do not perform these steps until a separate staging configuration approval is given.

1. Create a dedicated Goals Coach member Clerk application. Do not reuse the staff application.
2. Disable public registration and organization discovery. Provision only an explicitly approved owner identity through an invite or administrator-controlled creation.
3. Require verified email and MFA. Disable flows that allow a session to become active without a completed second factor.
4. Add a static custom claim to the ordinary Clerk session token: `aud` must exactly equal the approved value configured as `GOALS_COACH_MEMBER_CLERK_AUDIENCE`.
5. Record the exact issuer and configure it as `GOALS_COACH_MEMBER_CLERK_ISSUER`.
6. Configure the one approved frontend origin. Set the same exact value in the frontend authorized-party setting and backend alpha-origin variable. Do not use a wildcard or Sintra/public/staff origin.
7. Keep the secret key server-side. Only the publishable key may enter the frontend’s documented browser-visible variable.
8. Leave `GOALS_COACH_ALPHA_ENABLED=false` while configuration and mapping evidence are reviewed.
9. Verify with synthetic staging tests: valid token, invalid signature, wrong issuer, missing/wrong audience, missing/wrong authorized party, expired token, missing subject/session, missing MFA, inactive mapping, and unmapped subject.

Clerk’s verifier receives the configured audience, but the backend also performs an explicit exact check because the locked SDK does not reject a missing `aud` claim. The alpha therefore fails closed when the claim is missing.

## Owner-mapping procedure

Migration 003 must first be applied only to the approved disposable or staging database. Then use protected environment input with `npm run provision:alpha-owner`.

1. Resolve the exact existing `coach_members.id` through an authorized process. The script does not search by browser-supplied email or name.
2. Obtain the immutable Clerk `user_...` subject only after the dedicated Clerk setup is approved.
3. Set the action to `create`, provider to `clerk`, exact member ID, exact immutable subject, verified-email snapshot, and a non-sensitive approval reference.
4. Omit `GOALS_COACH_PROVISION_ACTIVATE` on the first run. New mappings are inactive by default.
5. Review the minimized result, which contains only action, status, mapping ID, and active state.
6. After separate approval, rerun with `GOALS_COACH_PROVISION_ACTIVATE=YES`. A subject mapped to a different member, a different active subject for the member, a changed email snapshot, or an ambiguous mapping fails closed.
7. To revoke access, use action `deactivate` with the exact member, provider, subject, and a documented reason. Deactivation preserves history and blocks the mapping on the next protected request.

Never paste protected values into command history, source control, logs, screenshots, tickets, or review documents.

## Origin and authorization design

The alpha origin guard is mounted before existing member CORS and is separate from staff origin protection. An approved browser preflight requires an exact configured origin. A non-browser request may omit the HTTP `Origin` header, but its Clerk session token must still contain the exact configured `azp`; missing `azp` is rejected.

After authentication, every protected request reloads the active `(provider, immutable subject)` database mapping. Browser-supplied email, member ID, plan ID, conversation ownership, role, audience, and account state are ignored for authorization. Profile, plan, history, messages, close, preferences, consent, and feedback are resolved against the mapped member.

## Migration and rollback

`npm run migrate:phase1a` applies `migration_003_goals_coach_alpha_foundation.sql` only after Migration 002 is recorded. It uses a transaction, advisory lock, and SHA-256 migration ledger. A rerun accepts only the exact recorded checksum.

`CONFIRM_PHASE1A_ROLLBACK=YES npm run rollback:phase1a` removes only Phase 1A additions. It refuses to run when a later migration is present. Rollback is destructive to Phase 1A alpha records and is not authorized for production by this document.

## Existing behavior and deployment status

The one-hop Railway trust-proxy setting, public member CORS, member verification, workout-plan generation, weekly check-ins, disabled GymMaster email behavior, Zapier safeguards, staff authentication/authorization, Phase 2 routes, and concurrency protections remain unchanged.

No Railway deployment, production migration, live Clerk configuration, environment-variable change, or live GymMaster, OpenAI, Zapier, or member-data call is part of Phase 1A local implementation.
