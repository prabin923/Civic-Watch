-- Dataset authority is time-limited independently from the parent case.
-- A nullable column keeps this migration compatible with legacy datasets;
-- legacy rows are backfilled to their case expiry and remain subject to the
-- normal authorization/review eligibility checks.
ALTER TABLE "TrainingDataset" ADD COLUMN "expiresAt" DATETIME;

UPDATE "TrainingDataset"
SET "expiresAt" = (
  SELECT "expiresAt"
  FROM "InvestigationCase"
  WHERE "InvestigationCase"."id" = "TrainingDataset"."caseId"
)
WHERE "expiresAt" IS NULL;

CREATE INDEX "TrainingDataset_caseId_status_expiresAt_idx"
ON "TrainingDataset"("caseId", "status", "expiresAt");
