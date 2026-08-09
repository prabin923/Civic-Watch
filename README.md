# CivicWatch Nepal pilot

A Next.js App Router implementation of the Nepal Vehicle Investigation Platform. It uses Tailwind CSS for the investigation console and Next route handlers for the partner edge-agent API.

Persistence is provided by Prisma ORM with a local SQLite database for development. The JSON-backed store has been removed.

## Run

```sh
npm run dev
```

Open `http://localhost:3000`. The application runs in a local demo session by default. Use the session role selector to switch role examples.

The public landing page is available without a session. The secure console uses an invite-style Prisma account and an HttpOnly session cookie. The local demo account is `admin@civicwatch.local` with password `CivicWatchDemo!2026`; change or remove this seeded account before any shared deployment. Set `AUTH_REQUIRED=true` outside the local demo and connect the login flow to agency SSO/MFA before operational use.

```sh
npm test
```

## Database

The local development database is `prisma/dev.db`, configured by `DATABASE_URL` in `.env`. The checked-in schema and initial migration are in `prisma/`.

```sh
# Generate the Prisma client after a schema change
npm run db:generate

# Create and apply a development migration
npm run db:migrate -- --name descriptive_change

# Restore the pilot's safe demo records
npm run db:seed
```

`npm test` synchronizes the local schema, resets the database to the safe demo data, and then runs the API-flow tests. For an operational deployment, use a managed, encrypted agency-approved database and `npm run db:deploy`; do not deploy the local SQLite file.

## Demo scenario

With `DEMO_MODE=true`, the MVP loads a clearly-labelled synthetic Kathmandu case: three fictional partner cameras, one synthetic watchlist, two reviewer-verified sightings, one candidate waiting for review, and one synthetic image-place lead. Nothing is fetched from a real camera or external service.

Select **Administrator** in the local role selector to show **Reset demo**. It restores the synthetic scenario through `POST /api/demo/reset`. Set `DEMO_MODE=false` in every non-demo environment; the reset endpoint is then unavailable.

## Included controls

- Active case and watchlist expiry enforcement; a watchlist cannot outlive its case.
- Partner camera registry with owner, fixed location, direction, retention, and authorization reference.
- Edge-agent enrollment, heartbeat, idempotent `possible_match` submission, and rejection of raw footage / non-case-scoped detections.
- Human review queue where a documented reviewer decision is required before a candidate becomes a verified map sighting.
- Case-scoped map layer containing metadata and an evidence-access token—not raw footage.
- Append-only hash-linked audit records and supervisor-only export.
- Reference-media job endpoint that only accepts an approved evidence-vault reference, not third-party capture.

## Image place leads

Operators, supervisors, and administrators can submit a case-scoped JPEG, PNG, or WebP image up to 5 MB, together with a documented submitter-authority reference. The service processes the uploaded image in memory and stores only its SHA-256 checksum and derived lead metadata; it does not retain the raw image.

The default provider is local. The MVP first reads embedded GPS metadata, then invokes the locally installed Tesseract binary in a temporary OS directory. It deletes that temporary image immediately after OCR. If OCR finds candidate sign text and `LOCAL_NOMINATIM_URL` points to an agency-operated Nominatim instance, the service queries that local gazetteer for an address candidate. No image or coordinates are sent to Google by this path.

When `DEMO_MODE=true`, a small offline Kathmandu pilot gazetteer is also available. It can only match a curated set of well-known landmark and neighbourhood names found in OCR text (for example, Kathmandu Durbar Square or Thamel). It is not a visual geolocation model, does not cover arbitrary images, and is deliberately disabled outside demo mode. Every match is labelled as a confidence-based lead and still requires reviewer approval.

Install Tesseract on the application host (for example, `brew install tesseract` on macOS) and set `LOCAL_TESSERACT_LANGUAGES=eng`. For Nepali/Devanagari signs, install `tesseract-lang` and configure a second local pass with `LOCAL_TESSERACT_SECONDARY_LANGUAGE=nep` and `LOCAL_TESSERACT_SECONDARY_TESSDATA_DIR` pointing to the directory that contains `nep.traineddata` (Homebrew ARM Macs: `/opt/homebrew/opt/tesseract-lang/share/tessdata`). For an operational deployment, import approved OpenStreetMap extracts into an agency-operated Nominatim service and set `LOCAL_NOMINATIM_URL` to that internal service. Do **not** configure the public `nominatim.openstreetmap.org` endpoint for this platform.

Google Vision and Google Geocoding are opt-in fallbacks only. Set both `PLACE_ANALYSIS_GOOGLE_FALLBACK=true` and `AI_EXTERNAL_PROVIDER_AUTHORIZED=true` only when documented authority covers third-party processing, the applicable APIs are enabled, and the server key is restricted correctly. Every address, landmark, and coordinate remains an unverified lead until a reviewer approves, rejects, or escalates it with a written reason. A `Use synthetic sample` action is available in demo mode and does not send or process an image. A no-signal image returns an audited no-result rather than guessing a place.

## Model-training foundation

The MVP now includes a case-scoped model-governance workflow. It deliberately does **not** claim to train an LLM or create a Vertex job from the browser. Instead it provides the controlled records needed before training is authorized:

- Administrators create a dataset for one supported task: vehicle detection, vehicle attributes, vehicle re-identification, plate OCR, place geolocation, or evidence reasoning.
- Operators submit labels as approved `gs://` object references with hashes, provenance, and structured annotations. Raw media and base64 payloads are rejected.
- A reviewer must verify each label before it is eligible for export.
- Supervisors and administrators can export verified records as a controlled NDJSON custom-training handoff. The manifest contains GCS references, checksums, and annotations—not image bytes.
- Administrators register model profiles in `evaluation`, record a separate evaluation, and document time-limited approval. Only an `approved_for_pilot` model can submit a model finding.
- Model findings contain bounded evidence signals (for example OCR, landmark, GPS, vehicle, map, or camera context). Their deterministic evidence score prioritizes review only; it never changes a place lead, sighting, or map result automatically.

Set `GOOGLE_CLOUD_PROJECT` and `VERTEX_AI_REGION` to show the approved target in the console. Authenticate the actual Vertex training environment with agency workload identity or a service account stored in the cloud secret manager—never a browser key or committed service-account JSON. A production training pipeline must consume the exported records only after data governance approval and must evaluate held-out, authorized data for plate OCR accuracy, vehicle matching precision, geographic error, false-positive rate, and abstention behavior.

## CivicWatch AI v1

CivicWatch AI v1 is a controlled analysis layer, not a giant LLM. It creates only case-scoped, reviewer-gated **MODEL FINDING** records from approved evidence references. It cannot verify a sighting or place, create a global vehicle identity, dispatch anyone, or enforce an action.

Implemented locally:

- Deterministic mock contracts for vehicle detection, vehicle attributes, vehicle re-identification, plate OCR, place geolocation, and grounded evidence reasoning.
- Existing local Tesseract paths for place/plate OCR and the bounded local place-analysis pipeline.
- Deterministic evidence fusion for prioritizing review, with conflicts and uncertainty explicitly retained.
- Case-scoped AI endpoints, source hash/correlation-id deduplication, model approval expiry, model evaluations, review workflow, audit events, and AI dashboard pages.
- An optional Vertex/Gemini grounded-reasoning provider. It is server-side, accepts structured evidence only, requires schema-valid JSON output, and is disabled by default.

Not implemented or claimed:

- A trained CivicWatch-owned detection, attribute, re-identification, geolocation, or LLM model.
- Vertex training-job orchestration from the application.
- Any autonomous verification, current-location claim, enforcement, social-media scraping, Google Images collection, or third-party live-feed capture.

### Local development

Keep `VERTEX_AI_ENABLED=false` (the default). SQLite, the deterministic mock provider, local Tesseract, the pilot gazetteer, and synthetic demo records allow the complete reviewer workflow to run without Google Cloud.

### Google Cloud / Vertex setup

Set these server-only environment variables in the approved production environment:

```sh
GOOGLE_CLOUD_PROJECT=
VERTEX_AI_REGION=asia-south1
GOOGLE_CLOUD_STORAGE_BUCKET=
VERTEX_AI_MODEL_ENDPOINT=
VERTEX_AI_ENABLED=false
AI_EXTERNAL_PROVIDER_AUTHORIZED=false
VERTEX_AI_TIMEOUT_MS=12000
VERTEX_AI_CIRCUIT_BREAKER_FAILURES=3
VERTEX_AI_CIRCUIT_BREAKER_COOLDOWN_MS=60000
AI_MAX_REQUESTS_PER_MINUTE=30
```

When Vertex is enabled, use server-side Application Default Credentials/workload identity. Never commit a service-account JSON file, browser key, model credential, or bucket credential. The provider receives structured evidence only; it does not receive raw operational images.

### Training and approval workflow

Every training example needs a case, source hash, checksum, `gs://` reference, filename, MIME type, license, provenance, authorization, collection time, retention deadline, annotation, and reviewer approval. The eligibility check rejects missing lineage, inactive/expired datasets, expired cases, expired retention, and invalid storage references. See [training workflow](docs/civicwatch-ai-training.md), [data model](docs/civicwatch-ai-data-model.md), [model governance](docs/civicwatch-ai-model-governance.md), [security controls](docs/civicwatch-ai-security.md), and [evaluation](docs/civicwatch-ai-evaluation.md).

New model profiles begin in `evaluation`. Record a leakage-resistant evaluation, then an administrator gives an explicit approval with an expiry. Only then may the model produce a pending finding. The final decision remains with a reviewer.

## API sketch

- `POST /api/edge/register`, `POST /api/edge/heartbeat`, `POST /api/edge/events`
- `GET|POST /api/cases`, `GET|POST /api/watchlists`, `GET|POST /api/cameras`
- `POST /api/media-receipts`, `POST|GET /api/search-jobs`
- `GET|POST /api/place-leads`, `POST /api/place-leads/:id/review`
- `GET|POST /api/training/datasets`, `GET|POST /api/training/datasets/:id/examples`, `POST /api/training-examples/:id/review`
- `GET /api/training/datasets/:id/manifest`, `GET /api/training/datasets/:id/vertex-manifest`
- `GET|POST /api/models`, `GET /api/models/:id`, `POST /api/models/:id/evaluations`, `POST /api/models/:id/approve`, `POST /api/models/:id/retire`
- `POST /api/ai/analyze`, `POST /api/ai/vehicle-detection`, `POST /api/ai/vehicle-attributes`, `POST /api/ai/reidentification`, `POST /api/ai/place-analysis`, `POST /api/ai/evidence-reasoning`
- `GET|POST /api/model-findings`, `POST /api/model-findings/:id/review`
- `GET /api/sightings`, `GET /api/review-queue`, `POST /api/sightings/:id/review`
- `GET /api/map-layer`, `GET /api/evidence/:id`, `GET /api/audit/export`

The browser console uses the `x-demo-role` header only in local-demo mode. Deployments must set `API_AUTH_TOKEN` at minimum and, before an operational pilot, replace this demo identity with agency SSO + MFA, connect an approved evidence vault, configure a browser-restricted `GOOGLE_MAPS_BROWSER_KEY` (Maps JavaScript API), and have retention/deletion and chain-of-custody policies formally approved. Without that key, the interface uses its clearly-labelled local map-context fallback.

AI dashboard routes are `/dashboard/ai`, `/dashboard/ai/datasets`, `/dashboard/ai/models`, and `/dashboard/ai/findings`.

No face matching, passive vehicle index, automatic dispatch, social-media scraping, Google Images collection, copyrighted/unlicensed training ingestion, or third-party live-stream capture is included.
# Nepal-Investigation-Platform
