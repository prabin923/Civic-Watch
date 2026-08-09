# CivicWatch AI v1 model governance

## Tasks

- `vehicle_detection`
- `vehicle_attributes`
- `vehicle_reidentification`
- `plate_ocr`
- `place_geolocation`
- `evidence_reasoning`

## Lifecycle

`evaluation` → accepted evaluation record → administrator approval → `approved_for_pilot` → `retired`

Only a time-limited `approved_for_pilot` model may generate a pending case finding. Retirement or expiry blocks future findings without deleting historical audit evidence.

## Human decision boundary

Models may recommend only `review_required`, `insufficient_evidence`, `possible_match`, or `possible_location_lead`. `verified`, `dispatch`, and `enforcement` are rejected outputs.

The reviewer queue alone can approve, reject, or escalate a finding and requires a written reason. An approved model finding is case evidence; it does not automatically verify a sighting or a location.

## Findings terminology

The UI uses `MODEL FINDING`, `MODEL ESTIMATE`, `SIMILARITY CANDIDATE`, and `LOCATION LEAD`. It must not state that AI confirmed a vehicle, address, identity, or current location.
