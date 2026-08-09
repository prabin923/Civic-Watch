# CivicWatch AI v1 architecture

## Purpose and invariant

CivicWatch AI v1 is a controlled, case-scoped analysis layer for authorized evidence. It produces reviewer-gated `ModelFinding` records only. It does not create a global vehicle identity, verify sightings or locations, initiate dispatch, or access third-party live streams or social media.

```
approved evidence reference
  ├─ EXIF / local OCR / approved place pipeline
  ├─ vehicle detection / attributes / re-identification estimates
  └─ plate OCR
             ↓
      structured evidence + uncertainty
             ↓
    deterministic evidence fusion
             ↓
 optional grounded LLM (structured evidence only)
             ↓
    pending-review model finding
             ↓
       trained human reviewer
```

## Repository map

| Area | Current responsibility |
| --- | --- |
| `app/` | App Router page, layout, and the single catch-all Node route handler. |
| `components/` | Public portal/login and the case investigation console. |
| `lib/platform.js` | HTTP API orchestration, authorization, case/watchlist/sighting workflows, local place analysis, audits, and current model-governance routes. |
| `lib/auth.js` | Password hashing, Prisma session lifecycle, and HttpOnly session cookies. |
| `lib/prisma.js` | Prisma 7 SQLite adapter setup. |
| `lib/pilot-gazetteer.js` | Demo-only, bounded Kathmandu OCR-name gazetteer. |
| `prisma/` | Schema, migrations, and a synthetic demo seed. |
| `test/` | Node integration tests exercising the native HTTP adapter. |
| configuration | `next.config.mjs`, `prisma.config.mjs`, Tailwind/PostCSS, and `.env.example`. |

## Implemented before AI v1

- Prisma models for cases, users/sessions, watchlists, cameras, edge agents, sightings, place leads, training datasets/examples, model profiles/findings, media receipts, search jobs, and hash-linked audit records.
- Active-case, case-role, and expiry enforcement for watchlists and edge events.
- Partner camera and edge-agent registration; edge event deduplication; raw frames and raw footage are rejected centrally.
- Human approval/rejection/escalation for sightings, place leads, training examples, and existing model findings.
- Local image-place pipeline: EXIF GPS, local Tesseract, demo-only gazetteer, optional agency-operated Nominatim, and an explicitly opt-in Google Vision/Geocoding fallback.
- Case-scoped training records that reference `gs://` object storage and exclude raw base64 media.
- A model registry plus controlled Vertex-style NDJSON export of reviewer-verified labels.
- Login/session authentication, local demo roles, and append-only hash-linked audit events.

## Bounded MVP behavior and planned work

- Local execution is implemented through deterministic mock detection, attribute, re-identification, plate OCR, place, and grounded-reasoning contracts. These are interface and reviewer-workflow implementations, not trained operational models.
- The existing local Tesseract place and plate paths remain available. The mock provider is used in local development and tests.
- Deterministic evidence fusion is implemented for review prioritization only; it never verifies an outcome.
- The optional Vertex/Gemini provider is implemented only for schema-validated grounded evidence reasoning. It is disabled by default and never receives raw image bytes.
- The `vertex-manifest` endpoint exports a handoff manifest. It does not start Vertex training. Evaluation records are controlled application records, not a remote training job.
- Google Vision remains an opt-in legacy landmark fallback for place analysis; it is not a training service or generalized image-analysis provider and now also requires explicit external-processing authorization.
- The database remains local SQLite for development. A production pilot still needs managed encrypted database and evidence-vault infrastructure.

## AI v1 design

AI modules are isolated from API orchestration:

```
lib/ai/
  index.js                 provider selection and analysis coordination
  types.js                 task, status, evidence, and recommendation contracts
  evidence-fusion.js       deterministic prioritization only
  model-registry.js        approval/expiry eligibility checks
  providers/
    mock.js                deterministic local/test provider
    vertex.js              opt-in server-side Vertex/Gemini provider
  vehicle/
    detection.js
    attributes.js
    reidentification.js
  ocr/plate.js
  place/analysis.js
  reasoning/grounded-llm.js
  validation/
    training.js
    model-output.js
```

Every module returns structured evidence with model/provider identity, version, source hash, generated time, confidence, and uncertainty. The only permitted recommendation values are `review_required`, `insufficient_evidence`, `possible_match`, and `possible_location_lead`.

## API map before AI v1

| API | Purpose |
| --- | --- |
| `/api/auth/*` | Login, session inspection, logout. |
| `/api/cases`, `/api/watchlists`, `/api/cameras` | Case-scoped investigation controls. |
| `/api/edge/*` | Edge-agent enrollment, heartbeat, and possible-match intake. |
| `/api/sightings`, `/api/review-queue`, `/api/sightings/:id/review` | Candidate and reviewer workflow. |
| `/api/place-leads*` | Case-scoped image location leads and review. |
| `/api/training/*`, `/api/training-examples/*` | Dataset, training-label, and manifest workflow. |
| `/api/models`, `/api/model-findings*` | Existing registry and manual model-finding workflow. |
| `/api/map-layer`, `/api/evidence/*`, `/api/audit*` | Controlled map/evidence metadata and audit export. |

## AI v1 additions

AI v1 adds approval-checked analysis endpoints under `/api/ai/*`, deterministic mock providers for local use, evidence-fusion output, optional schema-validated grounded LLM output, model approval expiry, dataset expiry, model evaluations, output validation, and direct dashboard pages at `/dashboard/ai`, `/dashboard/ai/datasets`, `/dashboard/ai/models`, and `/dashboard/ai/findings`. All writes remain in the application service, not inside a provider.

## Security boundaries

- External provider calls are disabled by default and server-side only.
- Providers receive case-authorized, bounded inputs; a grounded LLM receives structured evidence rather than database access.
- No source image bytes are stored in Prisma training tables.
- AI analysis never mutates a sighting, place lead, watchlist, or case status.
- Every AI request, provider outcome, finding, and reviewer decision appends an audit record with no secrets.
