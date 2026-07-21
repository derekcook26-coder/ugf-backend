# Phase 1E: GymMaster member-identity boundary

This document prepares for a single familiar member sign-in at
`ultimategoalsfitness.com/goalscoach`. It is an offline design boundary only.
It does not contact GymMaster, accept a GymMaster password, use an API key,
create a session, or enable any Goals Coach feature.

## Intended member experience

Members should continue with the GymMaster email and credentials they already
use for the GymMaster Member Portal. Goals Coach must not create a second
password. GymMaster does not offer a delegated or single-sign-on flow, so the
owner has selected a narrowly bounded password-transit model for later review.

An email address is a member identifier, not proof of authentication or active
membership. A browser-supplied email lookup cannot authorize a Goals Coach
session.

## Required GymMaster confirmation

Before any integration is configured, the owner must retain written provider
evidence for the exact supported authentication path. GymMaster's documented
Member Portal password-grant endpoint is the selected path for this boundary;
a future signed assertion or delegated OpenID Connect-style session could be
reviewed separately if GymMaster offers one.

The evidence must identify the exact endpoint, required key type, returned
member ID, token lifetime, and failure behavior. Current membership is not
accepted from the login response alone: Goals Coach independently checks the
existing Gatekeeper membership policy using the returned immutable member ID.
The email-template endpoint is not authentication documentation; it only sends
a chosen template to an email address.

## Documented password-grant path

GymMaster has documented a Member Portal `POST /portal/api/v1/login` endpoint
using the Members API key. It accepts a member email and password and returns a
login token, its expiration in seconds (generally one hour), and the GymMaster
member ID. The separate Staff API key is used for the email-template endpoint.

The same documentation describes a member-ID-only login using the Staff API
key. That is an administrative impersonation capability, not a member-facing
sign-in path. Goals Coach must not use it to authenticate a member.

The owner has approved review of this exact password-transit model: the member
enters the same GymMaster email and password they already use, Goals Coach sends
it directly to GymMaster over HTTPS with the Members API key, then immediately
discards the password. No second password is created. This is still not enabled
or configured: no API key, production endpoint, browser password form, provider
call, or session implementation is composed by this boundary. The review-only
adapter accepts an explicit injected endpoint and HTTP client so its exact
form-data contract can be tested without any live call.

If the flow is later configured, the GymMaster token must remain server-side and
must not be sent to the browser. Goals Coach must instead create its own
short-lived secure session only after a current active-member authorization
check. Login errors must stay generic, and the route must add rate limiting,
CSRF protection, HTTPS-only cookies, and credential-safe logging before it can
be enabled.

The proposed Goals Coach session carries only a random session ID plus the
immutable `gymmaster:<member-id>` subject. It is signed server-side, capped at
15 minutes even when GymMaster returns a longer-lived token, and stored only in
a host-only, `HttpOnly`, `Secure`, `SameSite=Strict` cookie scoped to
`/goalscoach`. Every protected request must then pass the existing active
mapping and current-consent checks; disabling a mapping blocks an existing
session immediately.

The proposed login handler remains absent by default. When separately composed,
it requires the exact `https://ultimategoalsfitness.com` origin, the injected
Members-key login service, and an active-member authorization callback before it
can set a session cookie. Its public responses contain no password, GymMaster
token, member ID, or provider failure details.

Before any provider request, the handler also requires a bounded local
per-client-address login-attempt limiter (five attempts per 15 minutes in the
proposed configuration). A refused attempt never reaches GymMaster and never
creates a session.

## Disabled startup composition

The startup factory is not imported by `server.js` and mounts no route. It is
disabled unless the dedicated feature switch is exactly `true`, the approved
HTTPS origin and both exact GymMaster URLs are valid, the Members and
Gatekeeper keys are server-side values, and a separate session secret is at
least 32 bytes. It returns safe configuration metadata only; it never returns
any key or secret, performs a database query, or contacts GymMaster during
startup.

An active Goals Coach mapping is an additional local authorization decision. The
existing Goals Coach 1.0 Gatekeeper integration supplies the current membership
check after password login: it looks up the exact returned member ID, rejects
`stopatgate`, and requires at least one non-expired membership. The browser does
not need to provide a first name or last initial again because GymMaster has
already authenticated the email/password. Both the local mapping and the live
Gatekeeper result must be active before a session is issued.

## Safety rules

- A member password may transit Goals Coach server memory only for the direct
  request to the documented GymMaster login endpoint; it is never persisted,
  logged, returned, or reused.
- The Members API key and GymMaster token are server-side secrets and must never
  be delivered to a browser.
- Member email remains a verified snapshot only after a provider-authenticated
  session is established.
- Existing Clerk-based private-alpha authentication remains unchanged until a
  separately reviewed migration plan exists. This boundary does not switch
  providers or weaken its issuer, audience, MFA, origin, or active-mapping
  checks.
- No routes, startup composition, provider calls, environment variables,
  migrations, deployments, or activation behavior are changed by this work.

## Review result

`member-identity-boundary` can only report either
`provider_contract_pending` or `ready_for_provider_configuration_review`.
Neither result permits activation, external calls, or password collection.
