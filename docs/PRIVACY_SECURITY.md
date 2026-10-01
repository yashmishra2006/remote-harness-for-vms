# Remote harness: privacy/security implementation record

Review date: 1 October 2026. These controls support an India/US compliance review; they are not a legal certification or an exhaustive security audit.

## Implemented controls

Node and Cloudflare hubs store SHA-256 session digests, migrate existing plaintext records, expire sessions after 30 days, and support server-side logout. Revoked browser sockets close. API responses are not cacheable. APP_PASSWORD and HUB_AGENT_TOKEN must each have at least 24 characters; provision random values before rollout. Sign-out clears private UI state. New browser clients send WebSocket credentials in a handshake protocol header rather than the URL; the server echoes only the non-secret protocol identifier. Upgrade hubs before clients. Legacy query-token clients remain supported during rollout; exclude credential headers and legacy query strings from access logs. Escanor notice links are available on sign-in and the user menu; self-hosted operators must supply their own applicable notices.

## Verification and rollout

Six Node regression tests passed, including HTTP login, both WebSocket handshake versions, logout, subsequent API rejection, stale HTTP responses and stale socket events. Sign-out closes the local socket immediately; responses from a different token/hub are rejected before updating the UI. Hub, worker and web typechecks and the web build passed. Cloudflare deployment behaviour still requires staging verification. Offline logout cannot confirm remote revocation; tokens expire independently.

No production deployment, real payment, regulator report or customer email was performed. Review historical logs for possible credential exposure, rotate affected credentials through the normal incident process, and preserve required evidence.

## Operational requirements

Identify the actual operator and controller/processor roles. Document data categories, purposes, active vendors, processing countries, retention/legal holds, access controls, backups and rights fulfilment. Staff verified privacy/grievance/security channels. Test deletion/export authorisation across tenant boundaries before promising automated fulfilment. Confirm Indian commencement dates and US state/sector applicability; do not apply superseded law or certify compliance from tests alone. CERT-In ICT-log obligations are not permission to retain all customer content indefinitely.

The central source register and release blockers are in the sibling escanor-web repository, docs/compliance/INDIA.md and docs/compliance/INDIA-US-REVIEW.md. Keep a copy of the approved notices and actual deployment evidence with each release.

## Integration verification

Reapplied to the latest origin default branch for the requested push/merge. 32 hub tests plus 3 browser privacy tests passed; hub/worker/web typechecks and Vite build passed. Upgrade hubs before clients. APP_PASSWORD and HUB_AGENT_TOKEN require 24+ characters; Cloudflare runtime migration needs staging verification. The original user checkout was preserved.
