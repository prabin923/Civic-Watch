-- CreateTable
CREATE TABLE "PlaceLead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "sourceFilename" TEXT,
    "sourceKind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT,
    "confidence" REAL,
    "latitude" REAL,
    "longitude" REAL,
    "status" TEXT NOT NULL,
    "explanation" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    "reviewedBy" TEXT,
    "reviewerReason" TEXT,
    CONSTRAINT "PlaceLead_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "InvestigationCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PlaceLead_caseId_status_createdAt_idx" ON "PlaceLead"("caseId", "status", "createdAt");
