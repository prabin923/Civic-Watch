# CivicWatch AI v1 data model

## Case boundary

Every AI record is connected to an `InvestigationCase`. The service rejects inactive or expired cases before accepting training material, invoking a model, exporting a manifest, or reviewing a finding. No table creates a global vehicle identity.

## Training datasets and examples

`TrainingDataset` has a case, task, authorization reference, approved storage region, label schema, lifecycle status, and `expiresAt`. Allowed statuses are `draft`, `ready_for_review`, `active`, and `inactive`.

`TrainingExample` stores metadata and labels only. It has:

- `id`, `datasetId`, `caseId`
- `sourceHash`, `checksum`, `storageReference`, `sourceFilename`, `mimeType`
- `license`, `provenance`, `authorizationRef`, `submitterAuthority`
- `collectionTimestamp`, `retentionUntil`
- `annotation`, `annotationStatus`, `reviewedBy`, and `reviewedAt`

Raw Base64 media is rejected. The reference must be a `gs://` object. When `GOOGLE_CLOUD_STORAGE_BUCKET` is configured, the reference must be in that exact approved bucket.

`isTrainingExampleEligible(example, context)` returns false unless the example has documented authorization, provenance, license, hashes, filename, MIME type, a valid storage reference, reviewer verification, an active/unexpired dataset, an active/unexpired case, and unexpired retention.

## Model registry and evaluations

`ModelProfile` records its dataset, provider, task, version, endpoint/reference, metrics, registration or approval reference, approval actor/time/expiry, and status. A new model must start as `evaluation`; it cannot be registered directly as pilot-approved. A separate accepted `ModelEvaluation` records metrics, split strategy, evaluation reference, evaluator, and status before an administrator can approve the model.

Pilot eligibility requires all of the following:

1. `status = approved_for_pilot`
2. model version and approval metadata
3. `approvalExpiresAt` in the future
4. case/task/dataset alignment

The API does not treat an average score as an approval decision. Approval is explicit, time-limited, and auditable.

## Findings

`ModelFinding` is the sole output persisted from an AI analysis. It carries case/model/task/source hash, provider and model version, bounded evidence signals, confidence, prioritization score, structured output, correlation ID, recommendation, review status, and reviewer reason. It begins as `pending_review` and cannot change a sighting, place lead, watchlist, or case.
