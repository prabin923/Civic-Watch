# CivicWatch AI v1 training workflow

Training is not started from the browser or application API. CivicWatch prepares reviewer-approved manifests for an agency-approved training pipeline.

## Authorized source workflow

1. Create an active, time-limited case-scoped dataset with a documented training authority.
2. Add only licensed, documented, approved-object-storage references and annotations.
3. A reviewer accepts or rejects each example with a written audit record.
4. A supervisor exports only eligible examples as an NDJSON manifest.
5. The approved offline/cloud pipeline trains or evaluates a candidate model.
6. Record the evaluation and use an administrator approval before pilot findings are enabled.

No social-media collection, Google Images collection, third-party live-stream capture, copyrighted/unlicensed data ingestion, or raw image database storage is part of this workflow.

## Dataset formats

### Vehicle detection

```json
{"image":"gs://approved-bucket/example.jpg","objects":[{"label":"vehicle","bbox":{"xMin":0.1,"yMin":0.2,"xMax":0.8,"yMax":0.9}}]}
```

### Vehicle attributes

```json
{"image":"gs://approved-bucket/example.jpg","attributes":{"color":"white","bodyType":"hatchback","make":"Suzuki","model":"Swift"}}
```

Attributes are labels for training/evaluation. Production output must say `Model estimate` and remains reviewable.

### Vehicle re-identification

```json
{"identityGroup":"vehicle_group_001","images":["gs://approved-bucket/a.jpg","gs://approved-bucket/b.jpg"]}
```

The group is a case-scoped training/evaluation construct. It is never exposed as a global vehicle identity.

### Evidence reasoning

```json
{"evidence":{"ocr":[],"exif":{},"vehicle":{},"similarity":{},"camera":{},"location":{}},"expectedOutput":{"summary":"...","uncertainties":[],"recommendation":"review_required"}}
```

## Split strategy and locked testing

Never randomly split neighboring video frames into train and test. Split by vehicle, source session, camera, and time as applicable. Re-identification testing must avoid identity overlap across splits. Keep a locked test set with separately documented access. The evaluation record stores the chosen split strategy.
