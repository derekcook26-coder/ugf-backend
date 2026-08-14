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
