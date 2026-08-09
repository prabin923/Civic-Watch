# CivicWatch AI v1 security controls

- Authentication, role checks, active-case checks, case scope, dataset scope, model task matching, and approval expiry are enforced at the API boundary.
- AI analysis accepts only an approved `gs://` reference, source hash, MIME type, and authorization reference. It rejects Base64 images, raw footage, frames, and third-party media retrieval.
- The local default is a deterministic mock provider. `VERTEX_AI_ENABLED=false` keeps external calls disabled.
- Vertex/Gemini reasoning is server-side only, requires explicit external-processing authorization and Application Default Credentials/workload identity, and receives structured evidence rather than image bytes or database access.
- Provider requests are payload-limited, rate-limited, timeout-bounded, and protected with a failure circuit breaker. Provider failures create audit events but no finding.
- Audits record actor, case, task, model/provider/version, source hash, correlation ID, and result reference. Audit detail recursively redacts credential-like values.
- Model providers contain no Prisma write access. The application service validates outputs before it writes a `ModelFinding`.
- Browser code never receives Google Cloud credentials, Vertex credentials, or service-account JSON.

Production still requires agency OIDC/MFA, WAF/rate-limit infrastructure, encrypted object storage, immutable/WORM audit retention, backup/recovery, retention/deletion policy, and formal legal/privacy review.
