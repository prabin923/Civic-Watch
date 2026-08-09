-- CivicWatch AI v1 keeps training lineage and execution outputs case-scoped.
-- Rebuild TrainingExample so existing records are retained while gaining the
-- mandatory provenance fields. Legacy rows remain ineligible until replaced
-- with documented training data.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_TrainingExample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "datasetId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "storageReference" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "sourceFilename" TEXT,
    "mimeType" TEXT NOT NULL,
    "submitterAuthority" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "authorizationRef" TEXT NOT NULL,
    "collectionTimestamp" DATETIME NOT NULL,
    "retentionUntil" DATETIME NOT NULL,
    "annotationJson" TEXT NOT NULL,
    "annotationStatus" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    "reviewedBy" TEXT,
    CONSTRAINT "TrainingExample_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "TrainingDataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrainingExample_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "InvestigationCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_TrainingExample" (
  "id", "datasetId", "caseId", "sourceHash", "storageReference", "checksum", "sourceFilename", "mimeType", "submitterAuthority", "license", "provenance", "authorizationRef", "collectionTimestamp", "retentionUntil", "annotationJson", "annotationStatus", "createdAt", "reviewedAt", "reviewedBy"
)
SELECT
  e."id", e."datasetId", d."caseId", e."sourceHash", e."storageReference", e."checksum", e."sourceFilename", e."mimeType", e."submitterAuthority",
  'legacy-record-requires-revalidation', 'legacy-record-requires-revalidation', e."submitterAuthority", e."createdAt", c."expiresAt", e."annotationJson", e."annotationStatus", e."createdAt", e."reviewedAt", e."reviewedBy"
FROM "TrainingExample" e
JOIN "TrainingDataset" d ON d."id" = e."datasetId"
JOIN "InvestigationCase" c ON c."id" = d."caseId";

DROP TABLE "TrainingExample";
ALTER TABLE "new_TrainingExample" RENAME TO "TrainingExample";

ALTER TABLE "ModelProfile" ADD COLUMN "endpointReference" TEXT;
ALTER TABLE "ModelProfile" ADD COLUMN "approvalExpiresAt" DATETIME;

ALTER TABLE "ModelFinding" ADD COLUMN "provider" TEXT;
ALTER TABLE "ModelFinding" ADD COLUMN "modelVersion" TEXT;
ALTER TABLE "ModelFinding" ADD COLUMN "recommendation" TEXT;
ALTER TABLE "ModelFinding" ADD COLUMN "outputJson" TEXT;
ALTER TABLE "ModelFinding" ADD COLUMN "correlationId" TEXT;
ALTER TABLE "ModelFinding" ADD COLUMN "requestHash" TEXT;

CREATE TABLE "ModelEvaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "metricsJson" TEXT NOT NULL,
    "splitStrategy" TEXT NOT NULL,
    "evaluationRef" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "evaluatedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelEvaluation_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ModelProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ModelEvaluation_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "TrainingDataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TrainingExample_datasetId_sourceHash_key" ON "TrainingExample"("datasetId", "sourceHash");
CREATE INDEX "TrainingExample_datasetId_annotationStatus_createdAt_idx" ON "TrainingExample"("datasetId", "annotationStatus", "createdAt");
CREATE INDEX "TrainingExample_caseId_retentionUntil_idx" ON "TrainingExample"("caseId", "retentionUntil");
CREATE UNIQUE INDEX "ModelFinding_requestHash_key" ON "ModelFinding"("requestHash");
CREATE INDEX "ModelEvaluation_modelId_createdAt_idx" ON "ModelEvaluation"("modelId", "createdAt");
CREATE INDEX "ModelEvaluation_datasetId_status_idx" ON "ModelEvaluation"("datasetId", "status");

PRAGMA foreign_keys=ON;
