# CivicWatch AI v1 evaluation

Evaluation records are required before pilot approval. Metrics are task-specific and are reviewed with error analysis, source coverage, false-positive risk, and reviewer workload; a high average score is never enough by itself.

| Task | Required evaluation focus |
| --- | --- |
| Vehicle detection | precision, recall, mAP, scene/weather/camera coverage |
| Vehicle attributes | per-attribute accuracy, precision, recall, confidence calibration |
| Re-identification | rank-1/rank-5, false-match and false-non-match rates, cross-camera behavior |
| Plate OCR | character accuracy, exact-match accuracy, false-read rate, English/Nepali coverage |
| Place geolocation | geographic error, city/neighborhood accuracy, abstention rate, unsupported location claims |
| Evidence reasoning | JSON validity, evidence grounding, unsupported-claim rate, reviewer agreement, abstention rate |

Evaluate day, night, rain, occlusion, blur, partial plates, and source-specific failures where the task needs them. Document the split strategy and preserve the locked test set. A result that is uncertain or insufficient must abstain rather than invent an exact location or identity.
