-- CreateTable
CREATE TABLE "TrainingDataset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "description" TEXT,
    "authorizationRef" TEXT NOT NULL,
    "storageRegion" TEXT NOT NULL,
    "labelSchemaJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "TrainingDataset_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "InvestigationCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrainingExample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "datasetId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "storageReference" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "sourceFilename" TEXT,
    "mimeType" TEXT NOT NULL,
    "submitterAuthority" TEXT NOT NULL,
    "annotationJson" TEXT NOT NULL,
    "annotationStatus" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    "reviewedBy" TEXT,
    CONSTRAINT "TrainingExample_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "TrainingDataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "datasetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "metricsJson" TEXT NOT NULL,
    "approvalRef" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" DATETIME,
    "approvedBy" TEXT,
    CONSTRAINT "ModelProfile_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "TrainingDataset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "placeLeadId" TEXT,
    "modelId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "evidenceScore" REAL NOT NULL,
    "status" TEXT NOT NULL,
    "explanation" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    "reviewedBy" TEXT,
    "reviewerReason" TEXT,
    CONSTRAINT "ModelFinding_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "InvestigationCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ModelFinding_placeLeadId_fkey" FOREIGN KEY ("placeLeadId") REFERENCES "PlaceLead" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ModelFinding_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ModelProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TrainingDataset_caseId_status_createdAt_idx" ON "TrainingDataset"("caseId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingExample_datasetId_sourceHash_key" ON "TrainingExample"("datasetId", "sourceHash");

-- CreateIndex
CREATE INDEX "TrainingExample_datasetId_annotationStatus_createdAt_idx" ON "TrainingExample"("datasetId", "annotationStatus", "createdAt");

-- CreateIndex
CREATE INDEX "ModelProfile_datasetId_status_task_idx" ON "ModelProfile"("datasetId", "status", "task");

-- CreateIndex
CREATE INDEX "ModelFinding_caseId_status_createdAt_idx" ON "ModelFinding"("caseId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ModelFinding_modelId_createdAt_idx" ON "ModelFinding"("modelId", "createdAt");
