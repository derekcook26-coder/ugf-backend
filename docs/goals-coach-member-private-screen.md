# Goals Coach member private screen

`GET /goalscoach/member/private-screen` is a disabled-by-default private shell
for an already authenticated GymMaster member. Only the exact string `true` for
`GOALS_COACH_MEMBER_PRIVATE_SCREEN_ENABLED` can mount it, and all session,
exact-origin, local-mapping, Gatekeeper, and server-side credential prerequisites
must also be valid.

Each request checks the signed member session before querying the active local
mapping, then checks current Gatekeeper membership. Unauthorized results are
concealed as one `401`; authenticated dependency failures receive a minimized
`503`. Successful access returns only the unavailable-coaching shell. Every
response is non-cacheable and carries `nosniff` protection.

This route does not enable login, enrollment, owner access, editable workouts,
coaching, safety, voice, plans, member writes, or provider activity at startup.

## Member safety setup

`GET` and `POST /goalscoach/member/safety-intake` form a separate authenticated,
disabled-by-default capability. Only the exact string `true` for
`GOALS_COACH_MEMBER_SAFETY_INTAKE_ALPHA_ENABLED` mounts the boundary. Startup
performs no database or provider request; each request revalidates the signed
session, exact active local mapping, and current Gatekeeper membership.

The API owns this approved, immutable version/text pair:

- Version: `GC-MEMBER-SAFETY-NOTICE-1`
- Notice: “Goals Coach uses the information you choose to provide, including
  fitness goals, workout feedback, and safety-related responses, to personalize
  your coaching experience. It does not replace medical advice. Your information
  is kept private and used only to provide and safely operate Goals Coach. You may
  stop using Goals Coach at any time.”

The five-answer submission acknowledges that version and persists only the
existing minimized safety/provenance record. Any positive answer makes the
effective result a safety stop and truthfully says no person was notified.
All-negative completion still returns coaching unavailable; it does not enable
AI, coaching, plans, voice, workouts, external calls, or activation.
