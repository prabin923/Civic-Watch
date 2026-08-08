-- CreateTable
CREATE TABLE "InvestigationCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "authorityRef" TEXT NOT NULL,
    "accessScope" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "permittedRoles" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Watchlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "plateNormalized" TEXT NOT NULL,
    "vehicleMake" TEXT,
    "vehicleModel" TEXT,
    "vehicleColor" TEXT,
    "vehicleType" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "accessScope" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Watchlist_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "InvestigationCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Camera" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "locationLabel" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL,
    "authorizationRef" TEXT NOT NULL,
    "authorizationExpiresAt" DATETIME,
    "lastHeartbeatAt" DATETIME
);

-- CreateTable
CREATE TABLE "EdgeAgent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lastHeartbeatAt" DATETIME,
    "scopes" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Sighting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "watchlistId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL,
    "confidence" REAL NOT NULL,
    "plateRead" TEXT,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "routeState" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "evidenceKind" TEXT NOT NULL,
    "evidenceChecksum" TEXT NOT NULL,
    "evidenceRetentionUntil" DATETIME,
    "reviewerReason" TEXT,
    "reviewedAt" DATETIME,
    "reviewedBy" TEXT,
    CONSTRAINT "Sighting_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "InvestigationCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Sighting_watchlistId_fkey" FOREIGN KEY ("watchlistId") REFERENCES "Watchlist" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Sighting_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SearchJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evidenceId" TEXT NOT NULL,
    "evidenceChecksum" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "activeCaseOnly" BOOLEAN NOT NULL DEFAULT true,
    "authorizedFeedsOnly" BOOLEAN NOT NULL DEFAULT true,
    "reviewerRequired" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "SearchJob_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "InvestigationCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MediaReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "storageReference" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "submitterAuthority" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MediaReceipt_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "InvestigationCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "detailJson" TEXT NOT NULL,
    "previousHash" TEXT,
    "hash" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "InvestigationCase_caseNumber_key" ON "InvestigationCase"("caseNumber");

-- CreateIndex
CREATE INDEX "InvestigationCase_status_expiresAt_idx" ON "InvestigationCase"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Watchlist_caseId_status_expiresAt_idx" ON "Watchlist"("caseId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EdgeAgent_keyHash_key" ON "EdgeAgent"("keyHash");

-- CreateIndex
CREATE UNIQUE INDEX "Sighting_eventId_key" ON "Sighting"("eventId");

-- CreateIndex
CREATE INDEX "Sighting_caseId_status_capturedAt_idx" ON "Sighting"("caseId", "status", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_hash_key" ON "AuditLog"("hash");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");
