# Phase 1E: owner-only member-login access

This checkpoint prepares a deliberately narrow, disabled-by-default owner test path for the future Goals Coach member login.

It conditionally composes a route in `server.js`, but configuration is absent by default, so no route exists in the running service. It does not configure Railway, contact GymMaster, contact an AI provider, or enable coaching. Separate written owner authorization and deliberate deployment configuration are still required before any request can reach this code.

## Required configuration for a future owner test

The normal GymMaster member-login foundation must first be configured according to `phase-1e-member-identity-boundary.md`. In addition, the deployment environment would require:

| Variable | Purpose |
| --- | --- |
| `GOALS_COACH_OWNER_ONLY_ALPHA_ENABLED` | Must be exactly `true`; any other value leaves owner-only access disabled. |
| `GOALS_COACH_OWNER_GYMMASTER_MEMBER_ID` | The owner’s positive GymMaster member ID. It is used only to compare the immutable member ID returned by GymMaster. |

The member ID is deployment configuration, not source code, browser data, or a value to place in a commit.

## Narrow behavior

Only when every requirement above is valid, the running backend mounts the router at `/goalscoach` with a separate exact-origin CORS policy. The router exposes only:

- `POST /login` — the existing Members-key password-login handler; it issues no session unless GymMaster login, Gatekeeper membership verification, the active local mapping, and the owner-ID comparison all succeed.
- `GET /session` — returns only owner-only status after validating a short-lived, host-only session cookie.

There are no conversation, message, workout, voice, safety, provider, or activation routes in this checkpoint. A non-owner receives the same generic login failure as any other failed login attempt, so the route does not disclose whether a GymMaster account belongs to the owner.

If the exact owner-only flag is missing or differs from the lowercase string `true`, the owner member ID is absent or invalid, or any required Member Portal/Gatekeeper/session/origin prerequisite is missing, the route is not mounted. Requests to `/goalscoach/login` and `/goalscoach/session` therefore receive the ordinary 404 response and cannot reach GymMaster.

## Security limits

- Member passwords transit only through the existing server-side Member Portal handler and are never persisted or returned to the browser.
- GymMaster tokens are not persisted or exposed to the browser.
- Staff-key impersonation is prohibited.
- The session cookie remains `HttpOnly`, `Secure`, `SameSite=Strict`, scoped to `/goalscoach`, and capped at 15 minutes.
- The owner-only session response explicitly reports `activationPermitted: false` and `externalCallsPermitted: false`.
