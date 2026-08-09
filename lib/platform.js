import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import exifr from 'exifr';
import { prisma as defaultPrisma } from './prisma.js';
import { clearSessionCookie, createSession, deleteSession, ensureDemoUser, publicUser, sessionCookieHeader, sessionUser, verifyPassword } from './auth.js';
import { matchPilotGazetteer } from './pilot-gazetteer.js';
import { AiPolicyError, MODEL_PROVIDERS, MODEL_STATUSES, MODEL_TASKS, isModelEligible, isTrainingExampleEligible, modelEligibility, runAiTask, runEvidenceFusion, validStorageReference, validateEvidenceSignals } from './ai/index.js';

const roles = new Set(['operator', 'reviewer', 'supervisor', 'administrator']);
const modelTasks = new Set(MODEL_TASKS);
const modelProviders = new Set(MODEL_PROVIDERS);
const modelStatuses = new Set(MODEL_STATUSES);
const maxPlaceImageBytes = 5 * 1024 * 1024;
const maxJsonBodyBytes = 7 * 1024 * 1024;
const execFile = promisify(execFileCallback);
const id = (prefix) => `${prefix}_${randomUUID()}`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date();
const normalizePlate = (value = '') => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

class HttpError extends Error {
  constructor(status, message, code = 'request_rejected') { super(message); this.status = status; this.code = code; }
}

const deny = (status, message, code) => { throw new HttpError(status, message, code); };
const requireRole = (actor, allowed) => { if (!allowed.includes(actor.role)) deny(403, 'Your role is not permitted to perform this action.', 'insufficient_role'); };
const hasModelGovernanceDelegates = (client) => ['trainingDataset', 'trainingExample', 'modelProfile', 'modelFinding', 'modelEvaluation'].every((key) => typeof client?.[key]?.findMany === 'function');
const requireModelGovernanceDelegates = (client) => { if (!hasModelGovernanceDelegates(client)) deny(503, 'Model governance is updating. Run Prisma generate, apply the database migration, and restart this service before using this feature.', 'model_governance_not_ready'); };

async function actorFrom(client, headers = {}) {
  const authenticatedUser = await sessionUser(client, headers);
  if (authenticatedUser) return { id: authenticatedUser.id, role: authenticatedUser.role, email: authenticatedUser.email, displayName: authenticatedUser.displayName };
  const apiToken = process.env.API_AUTH_TOKEN;
  if (apiToken && headers.authorization?.replace(/^Bearer\s+/i, '') !== apiToken) return null;
  if (process.env.AUTH_REQUIRED === 'true' || (process.env.NODE_ENV === 'production' && process.env.DEMO_MODE !== 'true')) return null;
  const role = headers['x-demo-role'] || 'operator';
  if (!roles.has(role)) return null;
  return { id: headers['x-demo-user'] || `demo.${role}`, role };
}

function caseDto(record) { return { ...record, permittedRoles: record.permittedRoles.split(',') }; }
function watchlistDto(record) { return { id: record.id, caseId: record.caseId, plate: record.plate, plateNormalized: record.plateNormalized, vehicle: { make: record.vehicleMake, model: record.vehicleModel, color: record.vehicleColor, type: record.vehicleType }, expiresAt: record.expiresAt, accessScope: record.accessScope, status: record.status, createdAt: record.createdAt }; }
function cameraDto(record) { return { id: record.id, name: record.name, owner: record.owner, sourceType: record.sourceType, status: record.status, direction: record.direction, location: { lat: record.latitude, lng: record.longitude, label: record.locationLabel }, retentionDays: record.retentionDays, authorizationRef: record.authorizationRef, authorizationExpiresAt: record.authorizationExpiresAt, lastHeartbeatAt: record.lastHeartbeatAt }; }
function sightingDto(record, includeCamera = false) {
  const value = { id: record.id, eventId: record.eventId, caseId: record.caseId, watchlistId: record.watchlistId, cameraId: record.cameraId, capturedAt: record.capturedAt, confidence: record.confidence, plateRead: record.plateRead, direction: record.direction, status: record.status, routeState: record.routeState, evidence: { id: record.evidenceId, kind: record.evidenceKind, checksum: record.evidenceChecksum, retentionUntil: record.evidenceRetentionUntil }, reviewerReason: record.reviewerReason, reviewedAt: record.reviewedAt, reviewedBy: record.reviewedBy };
  return includeCamera ? { ...value, camera: cameraDto(record.camera) } : value;
}
function placeLeadDto(record) {
  if (!record?.id) deny(500, 'The place lead could not be stored for review. No location was verified.', 'place_lead_persistence_failed');
  return { id: record.id, caseId: record.caseId, sourceHash: record.sourceHash, sourceFilename: record.sourceFilename, sourceKind: record.sourceKind, provider: record.provider, label: record.address || record.label, landmark: record.label, address: record.address, confidence: record.confidence, latitude: record.latitude, longitude: record.longitude, status: record.status, explanation: record.explanation, createdAt: record.createdAt, reviewedAt: record.reviewedAt, reviewedBy: record.reviewedBy, reviewerReason: record.reviewerReason };
}
function parseStoredJson(value, fallback = {}) { try { return JSON.parse(value); } catch { return fallback; } }
function trainingDatasetDto(record) {
  const counts = record._count || {};
  return { id: record.id, caseId: record.caseId, name: record.name, task: record.task, description: record.description, authorizationRef: record.authorizationRef, storageRegion: record.storageRegion, labelSchema: parseStoredJson(record.labelSchemaJson), status: record.status, expiresAt: record.expiresAt, createdAt: record.createdAt, createdBy: record.createdBy, exampleCount: counts.examples ?? 0, modelCount: counts.models ?? 0 };
}
function trainingExampleDto(record) { return { id: record.id, datasetId: record.datasetId, caseId: record.caseId, sourceHash: record.sourceHash, storageReference: record.storageReference, checksum: record.checksum, sourceFilename: record.sourceFilename, mimeType: record.mimeType, submitterAuthority: record.submitterAuthority, license: record.license, provenance: record.provenance, authorizationRef: record.authorizationRef, collectionTimestamp: record.collectionTimestamp, retentionUntil: record.retentionUntil, annotation: parseStoredJson(record.annotationJson), annotationStatus: record.annotationStatus, createdAt: record.createdAt, reviewedAt: record.reviewedAt, reviewedBy: record.reviewedBy }; }
function modelProfileDto(record) { return { id: record.id, datasetId: record.datasetId, name: record.name, provider: record.provider, task: record.task, version: record.version, status: record.status, metrics: parseStoredJson(record.metricsJson), approvalRef: record.approvalRef, endpointReference: record.endpointReference, createdAt: record.createdAt, approvedAt: record.approvedAt, approvedBy: record.approvedBy, approvalExpiresAt: record.approvalExpiresAt, eligibleForFindings: isModelEligible(record) }; }
function modelFindingDto(record, includeModel = false) {
  const value = { id: record.id, caseId: record.caseId, placeLeadId: record.placeLeadId, modelId: record.modelId, sourceHash: record.sourceHash, task: record.task, evidence: parseStoredJson(record.evidenceJson, []), confidence: record.confidence, evidenceScore: record.evidenceScore, status: record.status, explanation: record.explanation, provider: record.provider, modelVersion: record.modelVersion, recommendation: record.recommendation || 'review_required', output: parseStoredJson(record.outputJson, null), correlationId: record.correlationId, createdAt: record.createdAt, reviewedAt: record.reviewedAt, reviewedBy: record.reviewedBy, reviewerReason: record.reviewerReason };
  return includeModel ? { ...value, model: modelProfileDto(record.model) } : value;
}

function redactAuditDetail(value) {
  if (Array.isArray(value)) return value.map(redactAuditDetail);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(api.?key|password|token|secret|credential|service.?account)/i.test(key) ? '[REDACTED]' : redactAuditDetail(item)]));
}

async function appendAudit(client, actor, action, resource, detail = {}) {
  const previous = await client.auditLog.findFirst({ orderBy: { at: 'desc' } });
  const record = { id: id('audit'), at: now(), actor: actor.id, role: actor.role, action, resource, detailJson: JSON.stringify(redactAuditDetail(detail)), previousHash: previous?.hash || null };
  record.hash = hash(JSON.stringify({ ...record, at: record.at.toISOString() }));
  return client.auditLog.create({ data: record });
}

async function seed(client) {
  await ensureDemoUser(client);
  await client.placeLead.updateMany({ where: { sourceKind: 'synthetic_demo', address: null }, data: { address: 'Kathmandu Durbar Square, Kathmandu 44600, Nepal' } });
  if (await client.investigationCase.count()) {
    if (hasModelGovernanceDelegates(client)) await seedModelGovernance(client);
    return;
  }
  const createdAt = now();
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const authorizationExpiresAt = new Date(Date.now() + 145 * 24 * 60 * 60 * 1000);
  await client.$transaction(async (tx) => {
    await tx.investigationCase.create({ data: { id: 'case_KTM_0817', caseNumber: 'KTM-2026-0817', title: 'Missing vehicle recovery', status: 'active', authorityRef: 'KTM-CID-482/082', accessScope: 'kathmandu-pilot', expiresAt, createdAt, permittedRoles: 'operator,reviewer,supervisor,administrator' } });
    await tx.watchlist.create({ data: { id: 'watch_4421', caseId: 'case_KTM_0817', plate: 'BA 13 PA 4421', plateNormalized: 'BA13PA4421', vehicleMake: 'Suzuki', vehicleModel: 'Swift', vehicleColor: 'Pearl white', vehicleType: 'Hatchback', expiresAt, accessScope: 'kathmandu-pilot', status: 'active', createdAt } });
    await tx.camera.createMany({ data: [
      { id: 'cam_thamel_01', name: 'Thamel Junction — North', owner: 'Thamel Community Safety Partnership', sourceType: 'partner_edge', status: 'online', direction: 'Northbound', latitude: 27.7174, longitude: 85.3123, locationLabel: 'Tridevi Marg, Thamel', retentionDays: 14, authorizationRef: 'MOU-KTM-2026-014', authorizationExpiresAt, lastHeartbeatAt: createdAt },
      { id: 'cam_durbar_02', name: 'Durbar Marg — East', owner: 'Durbar Marg Business Association', sourceType: 'partner_edge', status: 'online', direction: 'Eastbound', latitude: 27.7124, longitude: 85.3189, locationLabel: 'Durbar Marg', retentionDays: 7, authorizationRef: 'MOU-KTM-2026-021', authorizationExpiresAt, lastHeartbeatAt: createdAt },
      { id: 'cam_putalisadak_03', name: 'Putalisadak — South', owner: 'Putalisadak Partner Network', sourceType: 'partner_edge', status: 'degraded', direction: 'Southbound', latitude: 27.7054, longitude: 85.3223, locationLabel: 'Putalisadak', retentionDays: 7, authorizationRef: 'MOU-KTM-2026-024', authorizationExpiresAt, lastHeartbeatAt: new Date(createdAt.getTime() - 13 * 60 * 1000) }
    ] });
    await tx.edgeAgent.create({ data: { id: 'agent_kathmandu_01', name: 'Kathmandu partner edge cluster', status: 'online', lastHeartbeatAt: createdAt, scopes: 'kathmandu-pilot', keyHash: hash('demo-edge-key') } });
    await tx.sighting.createMany({ data: [
      { id: 'sighting_001', eventId: 'evt_seed_001', caseId: 'case_KTM_0817', watchlistId: 'watch_4421', cameraId: 'cam_thamel_01', capturedAt: new Date(createdAt.getTime() - 26 * 60 * 1000), confidence: 0.93, plateRead: 'BA 13 PA 4421', direction: 'Northbound', status: 'verified', routeState: 'observed', evidenceId: 'evidence_001', evidenceKind: 'encrypted_clip_reference', evidenceChecksum: '4f6a…b904', evidenceRetentionUntil: expiresAt, reviewerReason: 'Plate characters, body shape and colour agree with the active watchlist.', reviewedAt: new Date(createdAt.getTime() - 19 * 60 * 1000), reviewedBy: 'reviewer.asha' },
      { id: 'sighting_002', eventId: 'evt_seed_002', caseId: 'case_KTM_0817', watchlistId: 'watch_4421', cameraId: 'cam_durbar_02', capturedAt: new Date(createdAt.getTime() - 10 * 60 * 1000), confidence: 0.79, plateRead: 'BA 13 PA 4421', direction: 'Eastbound', status: 'pending_review', routeState: 'possible_lead', evidenceId: 'evidence_002', evidenceKind: 'encrypted_clip_reference', evidenceChecksum: '9ca1…61d7', evidenceRetentionUntil: expiresAt },
      { id: 'sighting_003', eventId: 'evt_seed_003', caseId: 'case_KTM_0817', watchlistId: 'watch_4421', cameraId: 'cam_putalisadak_03', capturedAt: new Date(createdAt.getTime() - 4 * 60 * 1000), confidence: 0.88, plateRead: 'BA 13 PA 4421', direction: 'Southbound', status: 'verified', routeState: 'observed', evidenceId: 'evidence_003', evidenceKind: 'encrypted_clip_reference', evidenceChecksum: '0ce2…31af', evidenceRetentionUntil: expiresAt, reviewerReason: 'Synthetic demo review: the plate and vehicle descriptor are consistent with the watchlist.', reviewedAt: new Date(createdAt.getTime() - 2 * 60 * 1000), reviewedBy: 'reviewer.asha' }
    ] });
    await tx.placeLead.create({ data: { id: 'place_lead_001', caseId: 'case_KTM_0817', sourceHash: hash('synthetic-kathmandu-landmark-image'), sourceFilename: 'synthetic-durbar-square-image.jpg', sourceKind: 'synthetic_demo', provider: 'synthetic-demo', label: 'Kathmandu Durbar Square — synthetic image scenario', address: 'Kathmandu Durbar Square, Kathmandu 44600, Nepal', confidence: 0.74, latitude: 27.7049, longitude: 85.3075, status: 'pending_review', explanation: 'Synthetic landmark lead for the MVP demonstration. It does not come from an uploaded image.' } });
  });
  await appendAudit(client, { id: 'demo.system', role: 'demo' }, 'case.seeded', 'case_KTM_0817', { caseId: 'case_KTM_0817', synthetic: true });
  await appendAudit(client, { id: 'demo.reviewer', role: 'reviewer' }, 'candidate.approved', 'sighting_003', { caseId: 'case_KTM_0817', synthetic: true, reason: 'Synthetic demonstration record.' });
  if (hasModelGovernanceDelegates(client)) await seedModelGovernance(client);
}

async function seedModelGovernance(client) {
  const caseRecord = await client.investigationCase.findUnique({ where: { id: 'case_KTM_0817' } });
  if (!caseRecord) return;
  const vehicleDataset = await client.trainingDataset.upsert({ where: { id: 'dataset_vehicle_kathmandu_v1' }, update: {}, create: { id: 'dataset_vehicle_kathmandu_v1', caseId: caseRecord.id, name: 'Kathmandu vehicle attributes — synthetic pilot', task: 'vehicle_detection', description: 'Synthetic pilot examples only. Replace with documented, authorized samples before any training run.', authorizationRef: 'DEMO-ONLY-NO-PRODUCTION-USE', storageRegion: 'asia-south1', labelSchemaJson: JSON.stringify({ objects: [{ label: 'vehicle', box: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 }, attributes: ['colour', 'bodyType'] }] }), status: 'ready_for_review', expiresAt: caseRecord.expiresAt, createdBy: 'demo.system' } });
  const placeDataset = await client.trainingDataset.upsert({ where: { id: 'dataset_place_kathmandu_v1' }, update: {}, create: { id: 'dataset_place_kathmandu_v1', caseId: caseRecord.id, name: 'Kathmandu place signals — synthetic pilot', task: 'place_geolocation', description: 'Synthetic landmark and coordinate examples for the MVP workflow; not an operational geolocation model.', authorizationRef: 'DEMO-ONLY-NO-PRODUCTION-USE', storageRegion: 'asia-south1', labelSchemaJson: JSON.stringify({ latitude: 'number', longitude: 'number', landmark: 'string' }), status: 'ready_for_review', expiresAt: caseRecord.expiresAt, createdBy: 'demo.system' } });
  const taskDatasets = Object.fromEntries(await Promise.all([
    ['vehicle_attributes', 'Vehicle attributes', { attributes: { color: 'string', bodyType: 'string', make: 'string', model: 'string' } }],
    ['vehicle_reidentification', 'Vehicle re-identification', { identityGroup: 'case-scoped training/evaluation group', images: ['gs://approved/object.jpg'] }],
    ['plate_ocr', 'Plate OCR', { plateText: 'string', language: ['eng', 'nep'] }],
    ['evidence_reasoning', 'Evidence reasoning', { evidence: {}, expectedOutput: { recommendation: 'review_required' } }],
  ].map(async ([task, name, labelSchema]) => [task, await client.trainingDataset.upsert({ where: { id: `dataset_${task}_kathmandu_v1` }, update: {}, create: { id: `dataset_${task}_kathmandu_v1`, caseId: caseRecord.id, name: `${name} — synthetic pilot`, task, description: 'Synthetic pilot metadata only. It is not an operational training dataset.', authorizationRef: 'DEMO-ONLY-NO-PRODUCTION-USE', storageRegion: 'asia-south1', labelSchemaJson: JSON.stringify(labelSchema), status: 'ready_for_review', expiresAt: caseRecord.expiresAt, createdBy: 'demo.system' } })])));
  const trainingFields = { caseId: caseRecord.id, submitterAuthority: 'DEMO-ONLY-NO-PRODUCTION-USE', license: 'synthetic-demo-only', provenance: 'CivicWatch synthetic seed; no external image or training claim.', authorizationRef: 'DEMO-ONLY-NO-PRODUCTION-USE', collectionTimestamp: now(), retentionUntil: caseRecord.expiresAt, annotationStatus: 'reviewer_verified', reviewedAt: now(), reviewedBy: 'demo.reviewer' };
  await client.trainingExample.upsert({ where: { datasetId_sourceHash: { datasetId: vehicleDataset.id, sourceHash: hash('synthetic-kathmandu-vehicle-training-image') } }, update: trainingFields, create: { id: 'training_example_vehicle_001', datasetId: vehicleDataset.id, sourceHash: hash('synthetic-kathmandu-vehicle-training-image'), storageReference: 'gs://civicwatch-demo/synthetic/kathmandu-vehicle-001.jpg', checksum: hash('synthetic-kathmandu-vehicle-training-image'), sourceFilename: 'synthetic-kathmandu-vehicle-001.jpg', mimeType: 'image/jpeg', annotationJson: JSON.stringify({ objects: [{ label: 'vehicle', box: { xMin: 0.18, yMin: 0.26, xMax: 0.81, yMax: 0.83 }, attributes: { colour: 'white', bodyType: 'hatchback' } }] }), ...trainingFields } });
  await client.trainingExample.upsert({ where: { datasetId_sourceHash: { datasetId: placeDataset.id, sourceHash: hash('synthetic-kathmandu-landmark-image') } }, update: trainingFields, create: { id: 'training_example_place_001', datasetId: placeDataset.id, sourceHash: hash('synthetic-kathmandu-landmark-image'), storageReference: 'gs://civicwatch-demo/synthetic/kathmandu-durbar-square-001.jpg', checksum: hash('synthetic-kathmandu-landmark-image'), sourceFilename: 'synthetic-kathmandu-durbar-square-001.jpg', mimeType: 'image/jpeg', annotationJson: JSON.stringify({ latitude: 27.7049, longitude: 85.3075, landmark: 'Kathmandu Durbar Square', synthetic: true }), ...trainingFields } });
  const approvalExpiresAt = caseRecord.expiresAt;
  const approvedModel = async (id, datasetId, name, provider, task, metrics) => {
    const model = await client.modelProfile.upsert({ where: { id }, update: {}, create: { id, datasetId, name, provider, task, version: 'demo-1.0', status: 'approved_for_pilot', metricsJson: JSON.stringify(metrics), approvalRef: 'DEMO-ONLY-NO-PRODUCTION-USE', approvedAt: now(), approvedBy: 'demo.supervisor', approvalExpiresAt } });
    await client.modelEvaluation.upsert({ where: { id: `evaluation_${id}` }, update: { metricsJson: JSON.stringify(metrics), status: 'accepted', evaluatedBy: 'demo.supervisor' }, create: { id: `evaluation_${id}`, modelId: model.id, datasetId, metricsJson: JSON.stringify(metrics), splitStrategy: 'Synthetic fixture only; production evaluation requires case/session/camera/time-separated splits with a locked test set.', evaluationRef: 'DEMO-ONLY-NO-PRODUCTION-USE', status: 'accepted', evaluatedBy: 'demo.supervisor' } });
    return model;
  };
  await approvedModel('model_vehicle_demo_01', vehicleDataset.id, 'Vehicle detection baseline', 'custom_edge', 'vehicle_detection', { synthetic: true, precision: 0.91, recall: 0.88, validationNote: 'Illustrative only — no operational accuracy claim.' });
  await approvedModel('model_vehicle_attributes_demo_01', taskDatasets.vehicle_attributes.id, 'Vehicle attributes baseline', 'custom_edge', 'vehicle_attributes', { synthetic: true, perAttributeAccuracy: 0.84 });
  await approvedModel('model_vehicle_reid_demo_01', taskDatasets.vehicle_reidentification.id, 'Vehicle similarity baseline', 'custom_edge', 'vehicle_reidentification', { synthetic: true, rank1Accuracy: 0.72, falseMatchRate: 0.08 });
  await approvedModel('model_plate_demo_01', taskDatasets.plate_ocr.id, 'Plate OCR baseline', 'custom_edge', 'plate_ocr', { synthetic: true, characterAccuracy: 0.79, exactMatchAccuracy: 0.61 });
  const placeModel = await approvedModel('model_place_demo_01', placeDataset.id, 'Grounded place-signal baseline', 'evidence_fusion', 'place_geolocation', { synthetic: true, neighborhoodAccuracy: 0.56, abstentionRate: 0.41 });
  await approvedModel('model_reasoning_demo_01', taskDatasets.evidence_reasoning.id, 'Grounded evidence reasoning baseline', 'grounded_llm', 'evidence_reasoning', { synthetic: true, structuredOutputValidity: 1, reviewerAgreement: 0.7, unsupportedClaimRate: 0 });
  const placeLead = await client.placeLead.findUnique({ where: { id: 'place_lead_001' } });
  if (placeLead) await client.modelFinding.upsert({ where: { id: 'model_finding_place_001' }, update: {}, create: { id: 'model_finding_place_001', caseId: caseRecord.id, placeLeadId: placeLead.id, modelId: placeModel.id, sourceHash: placeLead.sourceHash, task: 'place_geolocation', evidenceJson: JSON.stringify([{ type: 'landmark', confidence: 0.74, claim: 'Synthetic demo landmark signal points to Kathmandu Durbar Square.', source: 'synthetic demo annotation' }, { type: 'map_context', confidence: 0.66, claim: 'Synthetic coordinates align with the scenario map context.', source: 'synthetic demo annotation' }]), confidence: 0.7, evidenceScore: 0.656, status: 'pending_review', explanation: 'Synthetic evidence-fusion finding for the model-governance demo. It is not a live or confirmed location.', provider: placeModel.provider, modelVersion: placeModel.version, recommendation: 'possible_location_lead', outputJson: JSON.stringify({ locationCandidate: { resolution: 'landmark_area', confidence: 0.7, status: 'pending_review' }, uncertainties: ['Synthetic demo only.'] }) } });
}

export async function resetAndSeed(client = defaultPrisma) {
  await client.auditLog.deleteMany();
  await client.mediaReceipt.deleteMany();
  await client.searchJob.deleteMany();
  if (hasModelGovernanceDelegates(client)) {
    await client.modelFinding.deleteMany();
    await client.modelEvaluation.deleteMany();
    await client.modelProfile.deleteMany();
    await client.trainingExample.deleteMany();
    await client.trainingDataset.deleteMany();
  }
  await client.placeLead.deleteMany();
  await client.sighting.deleteMany();
  await client.watchlist.deleteMany();
  await client.camera.deleteMany();
  await client.edgeAgent.deleteMany();
  await client.investigationCase.deleteMany();
  await seed(client);
}

async function accessibleCase(client, actor, caseId, activeOnly = false) {
  const record = await client.investigationCase.findUnique({ where: { id: caseId } });
  if (!record || !record.permittedRoles.split(',').includes(actor.role)) deny(403, 'You are not assigned to this case.', 'case_access_denied');
  if (activeOnly && (record.status !== 'active' || record.expiresAt <= now())) deny(403, 'This action requires an active, unexpired case.', 'case_not_active_or_authorized');
  return record;
}

function mapSighting(record) {
  const base = sightingDto(record);
  return { id: base.id, status: base.status, confidence: base.confidence, capturedAt: base.capturedAt, direction: base.direction, routeState: base.routeState, sourceId: record.camera.id, source: record.camera.name, location: cameraDto(record.camera).location, evidenceAccessToken: createHmac('sha256', process.env.API_AUTH_TOKEN || 'local-development-only').update(`${base.evidence.id}:${base.id}`).digest('base64url').slice(0, 22) };
}

function localNominatimBase() {
  const configured = process.env.LOCAL_NOMINATIM_URL?.trim();
  if (!configured) return null;
  try {
    const endpoint = new URL(configured);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.hostname.toLowerCase() === 'nominatim.openstreetmap.org') return null;
    return endpoint.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}
const externalImageProcessingAuthorized = () => process.env.AI_EXTERNAL_PROVIDER_AUTHORIZED === 'true';
const googleVisionFallbackEnabled = () => (process.env.PLACE_ANALYSIS_GOOGLE_FALLBACK === 'true' || process.env.PLACE_ANALYSIS_PROVIDER === 'google_vision') && externalImageProcessingAuthorized();
const pilotGazetteerEnabled = () => process.env.DEMO_MODE === 'true';
const imageExtension = (mimeType) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mimeType] || 'img');

function toCoordinate(value, maximum) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= maximum ? number : null;
}

function noLocationSignal(provider, explanation) {
  return { sourceKind: 'no_location_signal', provider, label: null, address: null, confidence: null, latitude: null, longitude: null, explanation };
}

// Providers may fail or return incomplete data for difficult images. Treat an
// incomplete response as an audited no-result rather than trying to infer a
// coordinate or allowing a malformed result to reach the reviewer queue.
export function normalizePlaceDetection(value) {
  if (!value || typeof value !== 'object') return noLocationSignal('place-analysis-validation', 'The image did not produce a trustworthy location signal. No place lead was created.');
  if (value.sourceKind === 'no_location_signal') return noLocationSignal(String(value.provider || 'place-analysis'), String(value.explanation || 'No reliable location signal was found in this image.'));

  const latitude = toCoordinate(value.latitude, 90);
  const longitude = toCoordinate(value.longitude, 180);
  const confidence = Number(value.confidence);
  const provider = typeof value.provider === 'string' && value.provider.trim() ? value.provider.trim().slice(0, 240) : null;
  const label = typeof value.label === 'string' && value.label.trim() ? value.label.trim().slice(0, 500) : null;
  const explanation = typeof value.explanation === 'string' && value.explanation.trim() ? value.explanation.trim().slice(0, 2_000) : null;
  if (!provider || !label || !explanation || latitude == null || longitude == null || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return noLocationSignal('place-analysis-validation', 'The image returned incomplete location evidence, so no place lead was created. Try an image with clear signage or embedded GPS metadata.');
  }
  return { sourceKind: String(value.sourceKind || 'place_analysis').slice(0, 120), provider, label, address: typeof value.address === 'string' && value.address.trim() ? value.address.trim().slice(0, 800) : null, confidence, latitude, longitude, explanation };
}

async function auditPlaceAnalysisFailure(client, actor, caseRecord, detail) {
  // An audit failure must never replace the safe public error returned to the
  // operator. The original source image stays out of the audit record.
  await appendAudit(client, actor, 'place_analysis.failed', caseRecord.id, {
    caseId: caseRecord.id,
    sourceHash: detail.sourceHash || null,
    sourceFilename: detail.sourceFilename || null,
    provider: detail.provider || 'place-analysis',
    failureCode: detail.failureCode || 'analysis_failed',
  }).catch(() => {});
}

function ocrSearchQueries(value) {
  const lines = String(value || '').split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length >= 4 && /[\p{L}\p{N}]/u.test(line));
  const compact = lines.join(', ').slice(0, 180);
  return [...new Set([compact, ...lines.slice(0, 3).map((line) => line.slice(0, 120))].filter(Boolean))].slice(0, 4);
}

async function runLocalTesseract(image, mimeType) {
  const command = process.env.LOCAL_TESSERACT_COMMAND || 'tesseract';
  const languages = process.env.LOCAL_TESSERACT_LANGUAGES || 'eng';
  const secondaryLanguage = process.env.LOCAL_TESSERACT_SECONDARY_LANGUAGE || null;
  const secondaryTessdataDir = process.env.LOCAL_TESSERACT_SECONDARY_TESSDATA_DIR || null;
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'civicwatch-ocr-'));
    const imagePath = join(directory, `source.${imageExtension(mimeType)}`);
    await writeFile(imagePath, image);
    const execute = async (language, tessdataDir = null) => {
      const args = [imagePath, 'stdout', '-l', language, '--psm', '11'];
      if (tessdataDir) args.push('--tessdata-dir', tessdataDir);
      const { stdout } = await execFile(command, args, { timeout: 15_000, maxBuffer: 512 * 1024, windowsHide: true });
      return String(stdout || '').trim();
    };
    const outputs = [await execute(languages)];
    if (secondaryLanguage && secondaryTessdataDir) outputs.push(await execute(secondaryLanguage, secondaryTessdataDir).catch(() => ''));
    return { available: true, text: outputs.filter(Boolean).join('\n') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { available: false, text: '' };
    return { available: true, text: '', failed: true };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function localNominatimRequest(path, parameters) {
  const base = localNominatimBase();
  if (!base) return null;
  try {
    const url = new URL(`${base}/${path.replace(/^\//, '')}`);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'CivicWatch-Nepal/0.1 (self-hosted-geocoder)' }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function searchLocalGazetteer(query) {
  const results = await localNominatimRequest('search', { format: 'jsonv2', limit: 1, q: query });
  const result = Array.isArray(results) ? results[0] : null;
  const latitude = toCoordinate(result?.lat, 90); const longitude = toCoordinate(result?.lon, 180);
  return latitude == null || longitude == null || !result?.display_name ? null : { address: result.display_name, latitude, longitude, importance: Math.min(Math.max(Number(result.importance || 0), 0), 1) };
}

async function detectLocalOcrPlace(image, mimeType) {
  if (process.env.LOCAL_TESSERACT_ENABLED === 'false') return { sourceKind: 'no_location_signal', provider: 'local-tesseract', label: null, address: null, confidence: null, latitude: null, longitude: null, explanation: 'Local OCR is disabled for this environment.' };
  const ocr = await runLocalTesseract(image, mimeType);
  if (!ocr.available) return { sourceKind: 'no_location_signal', provider: 'local-tesseract', label: null, address: null, confidence: null, latitude: null, longitude: null, explanation: 'Local OCR is not installed. Install Tesseract and its required language data, then restart the service.' };
  if (ocr.failed) return { sourceKind: 'no_location_signal', provider: 'local-tesseract', label: null, address: null, confidence: null, latitude: null, longitude: null, explanation: 'Local OCR could not read this image. The source remains an audited no-result.' };
  const queries = ocrSearchQueries(ocr.text);
  if (!queries.length) return { sourceKind: 'no_location_signal', provider: 'local-tesseract', label: null, address: null, confidence: null, latitude: null, longitude: null, explanation: 'Local OCR found no usable sign or landmark text in this image.' };
  if (pilotGazetteerEnabled()) {
    for (const query of queries) {
      const candidate = matchPilotGazetteer(query);
      if (!candidate) continue;
      return { sourceKind: 'pilot_ocr_gazetteer', provider: 'local-tesseract + civicwatch-pilot-gazetteer', label: `OCR sign candidate: ${candidate.name}`, address: candidate.address, confidence: 0.56, latitude: candidate.latitude, longitude: candidate.longitude, explanation: `Local OCR matched “${candidate.matchedAlias}” against the limited Kathmandu pilot gazetteer. This synthetic MVP lookup is a confidence-based lead only; verify the sign reading, place match, source authority, and image provenance before case use.` };
    }
  }
  if (!localNominatimBase()) return { sourceKind: 'no_location_signal', provider: pilotGazetteerEnabled() ? 'local-tesseract + civicwatch-pilot-gazetteer' : 'local-tesseract', label: null, address: null, confidence: null, latitude: null, longitude: null, explanation: pilotGazetteerEnabled() ? 'Local OCR found sign text, but it did not match the limited Kathmandu pilot gazetteer. Configure an approved internal geocoder for broader address lookup.' : 'Local OCR found sign text, but no self-hosted gazetteer is configured to turn it into a place lead.' };
  for (const query of queries) {
    const candidate = await searchLocalGazetteer(query);
    if (!candidate) continue;
    const confidence = Number(Math.min(0.68, 0.42 + candidate.importance * 0.18 + Math.min(query.length / 180, 1) * 0.08).toFixed(3));
    return { sourceKind: 'local_ocr_geocoder', provider: 'local-tesseract + self-hosted-nominatim', label: `OCR sign candidate: ${query}`, address: candidate.address, confidence, latitude: candidate.latitude, longitude: candidate.longitude, explanation: 'A locally extracted sign-text query matched a self-hosted gazetteer. This is a confidence-based lead; verify the sign reading, place match, and image provenance before case use.' };
  }
  return { sourceKind: 'no_location_signal', provider: 'local-tesseract + self-hosted-nominatim', label: null, address: null, confidence: null, latitude: null, longitude: null, explanation: 'Local OCR extracted text, but the self-hosted gazetteer returned no reliable place candidate.' };
}

async function reverseGeocode(latitude, longitude) {
  const localResult = await localNominatimRequest('reverse', { format: 'jsonv2', lat: latitude, lon: longitude, zoom: 18 });
  if (localResult?.display_name) return { address: localResult.display_name, provider: 'self-hosted-nominatim' };
  if (!googleVisionFallbackEnabled()) return null;
  const key = process.env.GOOGLE_GEOCODING_API_KEY || process.env.GOOGLE_MAPS_SERVER_KEY || process.env.GOOGLE_VISION_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(`${latitude},${longitude}`)}&key=${encodeURIComponent(key)}`);
    if (!response.ok) return null;
    const result = (await response.json()).results?.[0];
    return result?.formatted_address ? { address: result.formatted_address, provider: 'google-geocoding-fallback' } : null;
  } catch {
    return null;
  }
}

async function detectGoogleVisionLandmark(image) {
  const visionResponse = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(process.env.GOOGLE_VISION_API_KEY)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requests: [{ image: { content: image.toString('base64') }, features: [{ type: 'LANDMARK_DETECTION', maxResults: 1 }] }] }) });
  if (!visionResponse.ok) {
    if (visionResponse.status === 403) deny(502, 'Google Vision rejected the configured server key. Enable the Cloud Vision API and billing in that key’s Google Cloud project, then allow the Cloud Vision API in the key restrictions.', 'place_provider_not_authorized');
    if (visionResponse.status === 429) deny(503, 'Google Vision is temporarily rate-limited or quota-limited. Check the project quota and retry later.', 'place_provider_rate_limited');
    deny(502, 'The configured landmark-analysis provider could not process this image.', 'place_provider_unavailable');
  }
  const annotation = (await visionResponse.json()).responses?.[0]?.landmarkAnnotations?.[0];
  const latLng = annotation?.locations?.[0]?.latLng;
  if (annotation && latLng?.latitude != null && latLng?.longitude != null) {
    const location = await reverseGeocode(latLng.latitude, latLng.longitude);
    return { sourceKind: 'landmark_analysis', provider: location ? `google-vision-landmark + ${location.provider}` : 'google-vision-landmark', label: annotation.description || 'Possible landmark', address: location?.address || null, confidence: Math.min(Math.max(Number(annotation.score || 0.6), 0), 1), latitude: latLng.latitude, longitude: latLng.longitude, explanation: location ? 'A fallback landmark coordinate was resolved to an address. The landmark, coordinates, address, and image provenance require human review.' : 'A fallback landmark location was returned by the configured vision provider. It must be reviewed against the source image and case context.' };
  }
  return { sourceKind: 'no_location_signal', provider: 'google-vision-landmark-fallback', label: null, address: null, confidence: null, latitude: null, longitude: null, explanation: 'No landmark location signal was returned for this image.' };
}

async function detectImageLocation(imageBase64, mimeType) {
  const acceptedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (!acceptedTypes.has(mimeType)) deny(422, 'Only JPEG, PNG, and WebP images are accepted for place analysis.', 'unsupported_image_type');
  const image = Buffer.from(imageBase64, 'base64');
  if (!image.length || image.length > maxPlaceImageBytes) deny(422, 'The image must be between 1 byte and 5 MB.', 'invalid_image_size');
  const gps = await exifr.gps(image).catch(() => null);
  if (gps?.latitude != null && gps?.longitude != null) {
    const location = await reverseGeocode(gps.latitude, gps.longitude);
    return { sourceKind: 'embedded_gps', provider: location ? `exif + ${location.provider}` : 'exif', label: 'Embedded image GPS coordinates', address: location?.address || null, confidence: 0.98, latitude: gps.latitude, longitude: gps.longitude, explanation: location ? 'Possible address resolved from embedded image GPS metadata. Verify image provenance, metadata integrity, and the geocoded result.' : 'Possible location derived from embedded image GPS metadata. Verify image provenance and metadata integrity.' };
  }
  const localResult = await detectLocalOcrPlace(image, mimeType);
  if (localResult.sourceKind !== 'no_location_signal') return localResult;
  if (googleVisionFallbackEnabled() && process.env.GOOGLE_VISION_API_KEY) return detectGoogleVisionLandmark(image);
  return localResult;
}

function requireText(value, field, maxLength = 500) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maxLength) deny(422, `${field} is required and must be no longer than ${maxLength} characters.`, 'validation_failed');
  return text;
}

function parseObject(value, field, maxLength = 30_000) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { deny(422, `${field} must be valid JSON.`, 'validation_failed'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || JSON.stringify(parsed).length > maxLength) deny(422, `${field} must be a compact JSON object.`, 'validation_failed');
  return parsed;
}

function validateTrainingAnnotation(task, value) {
  const annotation = parseObject(value, 'Annotation');
  const serialized = JSON.stringify(annotation);
  if (/(imageBase64|data:image|rawFootage)/i.test(serialized)) deny(422, 'Training annotations must not contain raw image data or footage.', 'raw_media_not_allowed');
  if (task === 'vehicle_detection') {
    if (!Array.isArray(annotation.objects) || !annotation.objects.length || annotation.objects.some((item) => !item?.label || !item?.box || !['xMin', 'yMin', 'xMax', 'yMax'].every((key) => Number.isFinite(Number(item.box[key])) && Number(item.box[key]) >= 0 && Number(item.box[key]) <= 1))) deny(422, 'Vehicle-detection annotations require labelled normalized bounding boxes.', 'invalid_annotation');
  }
  if (task === 'vehicle_attributes' && (!annotation.attributes || typeof annotation.attributes !== 'object' || Array.isArray(annotation.attributes))) deny(422, 'Vehicle-attribute annotations require an attributes object.', 'invalid_annotation');
  if (task === 'vehicle_reidentification') requireText(annotation.identityGroup || annotation.referenceGroup, 'Re-identification identity group', 120);
  if (task === 'plate_ocr') requireText(annotation.plateText, 'Plate text', 64);
  if (task === 'place_geolocation' && (!Number.isFinite(Number(annotation.latitude)) || !Number.isFinite(Number(annotation.longitude)) || Math.abs(Number(annotation.latitude)) > 90 || Math.abs(Number(annotation.longitude)) > 180)) deny(422, 'Place-geolocation annotations require valid latitude and longitude values.', 'invalid_annotation');
  if (task === 'evidence_reasoning' && (!annotation.evidence || !annotation.expectedOutput || typeof annotation.evidence !== 'object' || typeof annotation.expectedOutput !== 'object')) deny(422, 'Evidence-reasoning annotations require evidence and expectedOutput objects.', 'invalid_annotation');
  return annotation;
}

function validateModelEvidence(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) deny(422, 'Model findings require one to eight grounded evidence signals.', 'invalid_model_evidence');
  const allowedSignalTypes = new Set(['vehicle', 'vehicle_detection', 'vehicle_attributes', 'vehicle_similarity', 'plate_ocr', 'signage_ocr', 'landmark', 'embedded_gps', 'camera_context', 'map_context', 'location_candidate', 'evidence_fusion']);
  return value.map((signal) => {
    if (!signal || !allowedSignalTypes.has(signal.type) || !Number.isFinite(Number(signal.confidence)) || Number(signal.confidence) < 0 || Number(signal.confidence) > 1) deny(422, 'Each evidence signal requires an approved type and a confidence between 0 and 1.', 'invalid_model_evidence');
    return { type: signal.type, confidence: Number(signal.confidence), claim: requireText(signal.claim, 'Evidence claim', 500), source: requireText(signal.source, 'Evidence source', 240) };
  });
}

function scoreModelEvidence(signals) {
  const confidence = signals.reduce((total, signal) => total + signal.confidence, 0) / signals.length;
  const independentSources = new Set(signals.map((signal) => signal.type)).size;
  const corroboration = Math.min(Math.max(independentSources - 1, 0) * 0.04, 0.12);
  return { confidence: Number(confidence.toFixed(3)), evidenceScore: Number(Math.min(confidence * 0.88 + corroboration, 0.99).toFixed(3)) };
}

function vertexHandoffRecord(dataset, example) {
  return {
    schema: 'civicwatch.vertex.custom-training.v1',
    task: dataset.task,
    imageGcsUri: example.storageReference,
    sourceHash: example.sourceHash,
    checksum: example.checksum,
    mimeType: example.mimeType,
    annotation: parseStoredJson(example.annotationJson),
  };
}

const aiRequestWindows = new Map();
function enforceAiRateLimit(actor) {
  const limit = Math.max(1, Number(process.env.AI_MAX_REQUESTS_PER_MINUTE || 30));
  const key = `${actor.id}:${actor.role}`;
  const cutoff = Date.now() - 60_000;
  const entries = (aiRequestWindows.get(key) || []).filter((time) => time > cutoff);
  if (entries.length >= limit) deny(429, 'AI analysis rate limit reached. Retry after the review workload window resets.', 'ai_rate_limited');
  entries.push(Date.now()); aiRequestWindows.set(key, entries);
}

function aiSourceFrom(body) {
  const source = parseObject(body.source, 'Approved evidence source');
  const serialized = JSON.stringify(source);
  if (/(imageBase64|data:image|rawFootage|\bframe\b)/i.test(serialized)) deny(422, 'AI analysis accepts only approved object-storage references and structured evidence; do not send raw media in this request.', 'raw_media_not_allowed');
  const sourceHash = requireText(source.sourceHash, 'Source SHA-256 hash', 128);
  const storageReference = requireText(source.storageReference, 'Approved object-storage reference', 800);
  if (!validStorageReference(storageReference)) deny(422, 'AI analysis requires an approved gs:// object-storage reference.', 'approved_storage_required');
  const mimeType = requireText(source.mimeType, 'Source MIME type', 80);
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) deny(422, 'AI analysis accepts JPEG, PNG, or WebP evidence references only.', 'unsupported_image_type');
  return { sourceHash, storageReference, mimeType, sourceFilename: source.sourceFilename?.trim() || null, authorizationRef: requireText(source.authorizationRef, 'Source authorization reference', 240) };
}

function structuredEvidenceFrom(body) {
  const value = body.structuredEvidence || {};
  const evidence = parseObject(value, 'Structured evidence', 25_000);
  if (/(imageBase64|data:image|rawFootage)/i.test(JSON.stringify(evidence))) deny(422, 'Structured AI evidence must not contain raw media.', 'raw_media_not_allowed');
  return evidence;
}

function aiTaskForPath(path, body) {
  const fixed = {
    '/api/ai/vehicle-detection': 'vehicle_detection',
    '/api/ai/vehicle-attributes': 'vehicle_attributes',
    '/api/ai/reidentification': 'vehicle_reidentification',
    '/api/ai/place-analysis': 'place_geolocation',
    '/api/ai/evidence-reasoning': 'evidence_reasoning',
  }[path];
  return fixed || (path === '/api/ai/analyze' ? body.task : null);
}

function result(status, body, headers = {}) { return { status, body, headers }; }

export async function handleApi({ method, headers = {}, body = {} }, url, client = defaultPrisma) {
  await seed(client);
  const path = url.pathname;

  if (method === 'POST' && path === '/api/auth/login') {
    if (!body.email || !body.password) deny(422, 'Email and password are required.', 'validation_failed');
    const user = await client.user.findUnique({ where: { email: String(body.email).trim().toLowerCase() } });
    if (!user || user.status !== 'active' || !verifyPassword(String(body.password), user.passwordHash)) deny(401, 'Invalid email or password.', 'invalid_credentials');
    const session = await createSession(client, user.id);
    await appendAudit(client, { id: user.id, role: user.role }, 'auth.login', user.id, { userId: user.id });
    return result(200, { user: publicUser(user) }, { 'set-cookie': sessionCookieHeader(session.token, session.expiresAt), 'cache-control': 'no-store' });
  }
  if (method === 'GET' && path === '/api/auth/me') {
    const user = await sessionUser(client, headers);
    if (!user) deny(401, 'A signed-in session is required.', 'authentication_required');
    return result(200, { user: publicUser(user) }, { 'cache-control': 'no-store' });
  }
  if (method === 'POST' && path === '/api/auth/logout') {
    await deleteSession(client, headers);
    return result(200, { signedOut: true }, { 'set-cookie': clearSessionCookie(), 'cache-control': 'no-store' });
  }

  const actor = await actorFrom(client, headers);
  if (!actor) deny(401, 'Authentication is required.', 'authentication_required');
  if (path.startsWith('/api/ai/') || path.startsWith('/api/training/') || path.startsWith('/api/training-examples/') || path === '/api/models' || path.startsWith('/api/models/') || path.startsWith('/api/model-findings')) requireModelGovernanceDelegates(client);

  if (method === 'GET' && path === '/api/health') return result(200, { status: 'ok', service: 'civicwatch-nepal-pilot', persistence: 'prisma-sqlite', mode: process.env.API_AUTH_TOKEN ? 'token-gated' : 'local-demo', time: now() });
  if (method === 'GET' && path === '/api/session') return result(200, { actor, safeguards: ['case_scoped_access', 'reviewer_gate', 'audit_chain', 'no_passive_vehicle_index'] });
  if (method === 'GET' && path === '/api/config') return result(200, { demoMode: process.env.DEMO_MODE === 'true', placeDetection: { metadataEnabled: true, localOcrEnabled: process.env.LOCAL_TESSERACT_ENABLED !== 'false', pilotGazetteerEnabled: pilotGazetteerEnabled(), localGeocoderEnabled: Boolean(localNominatimBase()), googleVisionFallbackEnabled: googleVisionFallbackEnabled() && Boolean(process.env.GOOGLE_VISION_API_KEY), landmarkProviderEnabled: googleVisionFallbackEnabled() && Boolean(process.env.GOOGLE_VISION_API_KEY), reverseGeocodingEnabled: Boolean(localNominatimBase()) || (googleVisionFallbackEnabled() && Boolean(process.env.GOOGLE_GEOCODING_API_KEY || process.env.GOOGLE_MAPS_SERVER_KEY || process.env.GOOGLE_VISION_API_KEY)), providerMode: googleVisionFallbackEnabled() ? 'local_with_google_fallback' : pilotGazetteerEnabled() ? 'local_pilot_gazetteer' : 'local_only', maxImageBytes: maxPlaceImageBytes }, modelGovernance: { vertexProjectConfigured: Boolean(process.env.GOOGLE_CLOUD_PROJECT), vertexRegion: process.env.VERTEX_AI_REGION || null, vertexEnabled: process.env.VERTEX_AI_ENABLED === 'true', externalProcessingAuthorized: process.env.AI_EXTERNAL_PROVIDER_AUTHORIZED === 'true', supportedTasks: [...modelTasks], reviewerRequired: true, rawMediaStored: false, localProvider: 'deterministic_mock' }, maps: { provider: 'google_maps', enabled: Boolean(process.env.GOOGLE_MAPS_BROWSER_KEY), browserKey: process.env.GOOGLE_MAPS_BROWSER_KEY || null } });
  if (method === 'POST' && path === '/api/demo/reset') {
    if (process.env.DEMO_MODE !== 'true') deny(404, 'Demo reset is not available in this environment.', 'not_found');
    requireRole(actor, ['administrator']); await resetAndSeed(client); return result(200, { reset: true, scenario: 'synthetic-kathmandu-vehicle-route' });
  }
  if (method === 'GET' && path === '/api/place-leads') {
    const caseId = url.searchParams.get('caseId'); await accessibleCase(client, actor, caseId); const records = await client.placeLead.findMany({ where: { caseId }, orderBy: { createdAt: 'desc' } }); return result(200, { placeLeads: records.map(placeLeadDto) });
  }
  if (method === 'POST' && path === '/api/place-leads') {
    requireRole(actor, ['operator', 'supervisor', 'administrator']); const caseRecord = await accessibleCase(client, actor, body.caseId, true);
    let detected;
    let sourceHash;
    let sourceFilename = typeof body.filename === 'string' ? body.filename.trim().slice(0, 240) || null : null;
    try {
      if (body.demo === true) {
        if (process.env.DEMO_MODE !== 'true') deny(404, 'Synthetic image analysis is not available in this environment.', 'not_found');
        detected = { sourceKind: 'synthetic_demo', provider: 'synthetic-demo', label: 'Kathmandu Durbar Square — synthetic image scenario', address: 'Kathmandu Durbar Square, Kathmandu 44600, Nepal', confidence: 0.74, latitude: 27.7049, longitude: 85.3075, explanation: 'Synthetic landmark lead for the MVP demonstration. It does not come from an uploaded image.' };
        sourceHash = hash(`synthetic-image:${now().toISOString()}`); sourceFilename = 'synthetic-durbar-square-image.jpg';
      } else {
        if (!body.imageBase64 || !body.mimeType || !body.submitterAuthority?.trim()) deny(422, 'An authorized image, its MIME type, and documented submitter authority are required.', 'missing_authorized_image');
        const rawBase64 = String(body.imageBase64).replace(/^data:[^;]+;base64,/, ''); const image = Buffer.from(rawBase64, 'base64'); sourceHash = hash(image); detected = await detectImageLocation(rawBase64, body.mimeType);
      }
      detected = normalizePlaceDetection(detected);
      if (detected.sourceKind === 'no_location_signal') {
        await appendAudit(client, actor, 'place_analysis.no_location_signal', caseRecord.id, { caseId: caseRecord.id, provider: detected.provider, sourceHash });
        return result(202, { disposition: 'no_location_signal', explanation: detected.explanation });
      }
      const record = await client.placeLead.create({ data: { id: id('place_lead'), caseId: caseRecord.id, sourceHash, sourceFilename, sourceKind: detected.sourceKind, provider: detected.provider, label: detected.label, address: detected.address || null, confidence: detected.confidence, latitude: detected.latitude, longitude: detected.longitude, status: 'pending_review', explanation: detected.explanation } });
      if (!record?.id) deny(500, 'The place lead could not be stored for review. No location was verified.', 'place_lead_persistence_failed');
      await appendAudit(client, actor, 'place_analysis.created', record.id, { caseId: record.caseId, provider: record.provider, sourceKind: record.sourceKind, synthetic: record.sourceKind === 'synthetic_demo' });
      return result(202, { disposition: 'pending_human_review', placeLead: placeLeadDto(record) });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      await auditPlaceAnalysisFailure(client, actor, caseRecord, { sourceHash, sourceFilename, provider: 'place-analysis', failureCode: 'unexpected_provider_or_image_error' });
      deny(422, 'This image could not be safely analyzed. Try a different JPEG, PNG, or WebP image with clear signage or embedded GPS metadata.', 'place_analysis_failed');
    }
  }
  const placeReviewId = path.match(/^\/api\/place-leads\/([^/]+)\/review$/)?.[1];
  if (method === 'POST' && placeReviewId) {
    requireRole(actor, ['reviewer', 'supervisor', 'administrator']); const lead = await client.placeLead.findUnique({ where: { id: placeReviewId } }); if (!lead) deny(404, 'Place lead not found in an assigned case.', 'place_lead_not_found'); await accessibleCase(client, actor, lead.caseId);
    if (!['approve', 'reject', 'escalate'].includes(body.decision) || !body.reason?.trim()) deny(422, 'A review decision and reviewer reasoning are required.', 'validation_failed'); if (lead.status !== 'pending_review') deny(409, 'This place lead has already been reviewed.', 'already_reviewed');
    const record = await client.placeLead.update({ where: { id: lead.id }, data: { status: body.decision === 'approve' ? 'verified' : body.decision === 'reject' ? 'rejected' : 'escalated', reviewerReason: body.reason.trim(), reviewedBy: actor.id, reviewedAt: now() } }); const action = { approve: 'approved', reject: 'rejected', escalate: 'escalated' }[body.decision]; await appendAudit(client, actor, `place_lead.${action}`, record.id, { caseId: record.caseId, provider: record.provider, reason: record.reviewerReason }); return result(200, { placeLead: placeLeadDto(record) });
  }

  const aiTask = aiTaskForPath(path, body);
  if (method === 'POST' && aiTask) {
    requireRole(actor, ['operator', 'supervisor', 'administrator']); enforceAiRateLimit(actor);
    const caseRecord = await accessibleCase(client, actor, body.caseId, true);
    if (!modelTasks.has(aiTask)) deny(422, 'The requested AI task is not supported.', 'unsupported_model_task');
    const source = aiSourceFrom(body); const structuredEvidence = structuredEvidenceFrom(body);
    const model = await client.modelProfile.findUnique({ where: { id: body.modelId }, include: { dataset: true } });
    if (!model || model.dataset.caseId !== caseRecord.id || model.task !== aiTask) deny(403, 'The selected model is not assigned to this case and task.', 'model_not_authorized');
    const eligibility = modelEligibility(model);
    if (!eligibility.eligible) deny(403, 'The selected model is not currently approved for pilot findings.', eligibility.reasons.includes('approval_expired') ? 'model_approval_expired' : 'model_not_authorized');
    const correlationId = body.correlationId?.trim() || id('ai_request');
    const requestHash = hash(JSON.stringify({ caseId: caseRecord.id, modelId: model.id, task: aiTask, sourceHash: source.sourceHash, structuredEvidence }));
    const duplicate = await client.modelFinding.findUnique({ where: { requestHash }, include: { model: true } });
    if (duplicate) return result(202, { accepted: true, duplicate: true, disposition: 'pending_human_review', finding: modelFindingDto(duplicate, true) });
    await appendAudit(client, actor, 'ai.analysis.started', correlationId, { caseId: caseRecord.id, modelId: model.id, modelVersion: model.version, provider: model.provider, task: aiTask, sourceHash: source.sourceHash });
    try {
      await appendAudit(client, actor, 'ai.provider.called', correlationId, { caseId: caseRecord.id, modelId: model.id, modelVersion: model.version, provider: model.provider, task: aiTask, sourceHash: source.sourceHash });
      const aiResult = await runAiTask({ model, task: aiTask, source, caseContext: { caseNumber: caseRecord.caseNumber, title: caseRecord.title, accessScope: caseRecord.accessScope, expiresAt: caseRecord.expiresAt.toISOString() }, structuredEvidence, correlationId });
      const signals = validateEvidenceSignals(aiResult.evidence || []);
      const fusion = runEvidenceFusion({ signals, uncertainties: aiResult.uncertainties || [] });
      const record = await client.modelFinding.create({ data: { id: id('model_finding'), caseId: caseRecord.id, modelId: model.id, sourceHash: source.sourceHash, task: aiTask, evidenceJson: JSON.stringify(fusion.signals), confidence: Number(aiResult.confidence ?? fusion.score), evidenceScore: fusion.score, status: 'pending_review', explanation: aiResult.output?.summary || aiResult.uncertainties?.join(' ') || 'AI model result requires reviewer assessment.', provider: aiResult.provider, modelVersion: aiResult.modelVersion || model.version, recommendation: aiResult.recommendation || 'review_required', outputJson: JSON.stringify({ output: aiResult.output, uncertainties: fusion.uncertainties, conflicts: fusion.conflicts, source: { sourceHash: source.sourceHash, storageReference: source.storageReference, mimeType: source.mimeType } }), correlationId, requestHash } });
      await appendAudit(client, actor, 'ai.model.finding.created', record.id, { caseId: record.caseId, modelId: model.id, modelVersion: record.modelVersion, provider: record.provider, task: record.task, sourceHash: record.sourceHash, correlationId, resultReference: record.id });
      await appendAudit(client, actor, 'ai.analysis.completed', correlationId, { caseId: caseRecord.id, modelId: model.id, modelVersion: model.version, provider: aiResult.provider, task: aiTask, sourceHash: source.sourceHash, resultReference: record.id });
      return result(202, { accepted: true, disposition: 'pending_human_review', finding: modelFindingDto(record) });
    } catch (error) {
      await appendAudit(client, actor, error?.code?.startsWith('provider') ? 'ai.provider.failed' : 'ai.analysis.failed', correlationId, { caseId: caseRecord.id, modelId: model.id, modelVersion: model.version, provider: model.provider, task: aiTask, sourceHash: source.sourceHash, correlationId, errorCode: error?.code || 'internal_error' });
      throw error;
    }
  }

  if (method === 'GET' && path === '/api/training/datasets') {
    const caseId = url.searchParams.get('caseId'); await accessibleCase(client, actor, caseId);
    const records = await client.trainingDataset.findMany({ where: { caseId }, include: { _count: { select: { examples: true, models: true } } }, orderBy: { createdAt: 'desc' } });
    return result(200, { datasets: records.map(trainingDatasetDto) });
  }
  if (method === 'POST' && path === '/api/training/datasets') {
    requireRole(actor, ['administrator']); const caseRecord = await accessibleCase(client, actor, body.caseId, true);
    const task = requireText(body.task, 'Training task', 80);
    if (!modelTasks.has(task)) deny(422, 'The training task is not supported by this pilot.', 'unsupported_model_task');
    const status = body.status || 'draft';
    if (!['draft', 'ready_for_review', 'active', 'inactive'].includes(status)) deny(422, 'Training datasets must use a controlled lifecycle status.', 'invalid_dataset_status');
    const labelSchema = parseObject(body.labelSchema || { task }, 'Label schema');
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : caseRecord.expiresAt;
    if (Number.isNaN(expiresAt.valueOf()) || expiresAt <= now() || expiresAt > caseRecord.expiresAt) deny(422, 'Dataset expiry must be in the future and no later than the active case expiry.', 'invalid_dataset_expiry');
    const record = await client.trainingDataset.create({ data: { id: id('dataset'), caseId: caseRecord.id, name: requireText(body.name, 'Dataset name', 140), task, description: body.description?.trim() || null, authorizationRef: requireText(body.authorizationRef, 'Dataset authorization reference', 240), storageRegion: requireText(body.storageRegion, 'Approved storage region', 120), labelSchemaJson: JSON.stringify(labelSchema), status, expiresAt, createdBy: actor.id } });
    await appendAudit(client, actor, 'ai.training.dataset.created', record.id, { caseId: record.caseId, task: record.task, authorizationRef: record.authorizationRef, expiresAt: record.expiresAt });
    return result(201, { dataset: trainingDatasetDto(record) });
  }
  const datasetExampleMatch = path.match(/^\/api\/training\/datasets\/([^/]+)\/examples$/);
  if (method === 'GET' && datasetExampleMatch) {
    const dataset = await client.trainingDataset.findUnique({ where: { id: datasetExampleMatch[1] } }); if (!dataset) deny(404, 'Training dataset not found in an assigned case.', 'training_dataset_not_found'); await accessibleCase(client, actor, dataset.caseId);
    const records = await client.trainingExample.findMany({ where: { datasetId: dataset.id }, orderBy: { createdAt: 'desc' } });
    return result(200, { examples: records.map(trainingExampleDto) });
  }
  if (method === 'POST' && datasetExampleMatch) {
    requireRole(actor, ['operator', 'supervisor', 'administrator']); const dataset = await client.trainingDataset.findUnique({ where: { id: datasetExampleMatch[1] } }); if (!dataset) deny(404, 'Training dataset not found in an assigned case.', 'training_dataset_not_found'); const caseRecord = await accessibleCase(client, actor, dataset.caseId, true);
    if (!['active', 'ready_for_review'].includes(dataset.status) || !dataset.expiresAt || dataset.expiresAt <= now()) deny(403, 'Training examples require an active, unexpired, case-authorized dataset.', 'training_dataset_not_active');
    const storageReference = requireText(body.storageReference, 'Controlled GCS image reference', 800);
    if (!validStorageReference(storageReference)) deny(422, 'Training examples must reference an approved gs:// object; raw image bytes are never accepted here.', 'approved_storage_required');
    const mimeType = requireText(body.mimeType, 'Image MIME type', 80);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) deny(422, 'Training examples must be JPEG, PNG, or WebP images.', 'unsupported_image_type');
    const collectionTimestamp = new Date(body.collectionTimestamp);
    const retentionUntil = new Date(body.retentionUntil);
    const retentionLimit = dataset.expiresAt && dataset.expiresAt < caseRecord.expiresAt ? dataset.expiresAt : caseRecord.expiresAt;
    if (Number.isNaN(collectionTimestamp.valueOf()) || collectionTimestamp > now() || Number.isNaN(retentionUntil.valueOf()) || retentionUntil <= now() || retentionUntil > retentionLimit) deny(422, 'Training examples require a non-future collection date and a future retention date no later than the dataset and case expiry.', 'invalid_retention');
    const annotation = validateTrainingAnnotation(dataset.task, body.annotation);
    const record = await client.trainingExample.create({ data: { id: id('training_example'), datasetId: dataset.id, caseId: caseRecord.id, sourceHash: requireText(body.sourceHash, 'Source SHA-256 hash', 128), storageReference, checksum: requireText(body.checksum, 'Evidence checksum', 128), sourceFilename: requireText(body.sourceFilename, 'Source filename', 400), mimeType, submitterAuthority: requireText(body.submitterAuthority, 'Submitter authority reference', 240), license: requireText(body.license, 'Training-data license', 240), provenance: requireText(body.provenance, 'Training-data provenance', 800), authorizationRef: requireText(body.authorizationRef, 'Training-data authorization reference', 240), collectionTimestamp, retentionUntil, annotationJson: JSON.stringify(annotation), annotationStatus: 'pending_review' } }).catch((error) => {
      if (error.code === 'P2002') deny(409, 'This source is already recorded in the dataset.', 'duplicate_training_example'); throw error;
    });
    await appendAudit(client, actor, 'ai.training.example.created', record.id, { caseId: dataset.caseId, datasetId: dataset.id, task: dataset.task, sourceHash: record.sourceHash, authorizationRef: record.authorizationRef, provenance: record.provenance });
    return result(202, { disposition: 'pending_human_review', example: trainingExampleDto(record) });
  }
  const trainingExampleReviewId = path.match(/^\/api\/training-examples\/([^/]+)\/review$/)?.[1];
  if (method === 'POST' && trainingExampleReviewId) {
    requireRole(actor, ['reviewer', 'supervisor', 'administrator']); const example = await client.trainingExample.findUnique({ where: { id: trainingExampleReviewId }, include: { dataset: true } }); if (!example) deny(404, 'Training example not found in an assigned case.', 'training_example_not_found'); await accessibleCase(client, actor, example.dataset.caseId);
    if (!['approve', 'reject'].includes(body.decision) || !body.reason?.trim()) deny(422, 'A label review decision and written reasoning are required.', 'validation_failed'); if (example.annotationStatus !== 'pending_review') deny(409, 'This training example has already been reviewed.', 'already_reviewed');
    const record = await client.trainingExample.update({ where: { id: example.id }, data: { annotationStatus: body.decision === 'approve' ? 'reviewer_verified' : 'rejected', reviewedAt: now(), reviewedBy: actor.id } });
    await appendAudit(client, actor, 'ai.training.example.reviewed', record.id, { caseId: example.dataset.caseId, datasetId: record.datasetId, decision: body.decision, reason: body.reason.trim() });
    return result(200, { example: trainingExampleDto(record) });
  }
  const vertexManifestDatasetId = path.match(/^\/api\/training\/datasets\/([^/]+)\/(?:vertex-)?manifest$/)?.[1];
  if (method === 'GET' && vertexManifestDatasetId) {
    requireRole(actor, ['supervisor', 'administrator']); const dataset = await client.trainingDataset.findUnique({ where: { id: vertexManifestDatasetId } }); if (!dataset) deny(404, 'Training dataset not found in an assigned case.', 'training_dataset_not_found'); const caseRecord = await accessibleCase(client, actor, dataset.caseId);
    const examples = await client.trainingExample.findMany({ where: { datasetId: dataset.id, annotationStatus: 'reviewer_verified' }, orderBy: { createdAt: 'asc' } });
    const eligibleExamples = examples.filter((example) => isTrainingExampleEligible(example, { dataset, caseRecord }));
    if (!eligibleExamples.length) deny(409, 'A training handoff requires at least one reviewer-verified, authorized, retained training example.', 'no_eligible_training_examples');
    const manifest = eligibleExamples.map((example) => vertexHandoffRecord(dataset, example));
    await appendAudit(client, actor, 'ai.training.manifest.exported', dataset.id, { caseId: dataset.caseId, datasetId: dataset.id, records: manifest.length });
    if (url.searchParams.get('download') === '1') return { status: 200, raw: manifest.map((record) => JSON.stringify(record)).join('\n'), headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'content-disposition': `attachment; filename="vertex-handoff-${dataset.id}.ndjson"`, 'cache-control': 'no-store' } };
    return result(200, { dataset: trainingDatasetDto(dataset), manifest, notice: 'This is a custom-training handoff manifest. Import it only into the approved Vertex AI project and adapt annotations to the selected Vertex dataset type.' });
  }
  if (method === 'GET' && path === '/api/models') {
    const caseId = url.searchParams.get('caseId'); await accessibleCase(client, actor, caseId);
    const records = await client.modelProfile.findMany({ where: { dataset: { caseId } }, orderBy: { createdAt: 'desc' } });
    return result(200, { models: records.map(modelProfileDto) });
  }
  const modelIdMatch = path.match(/^\/api\/models\/([^/]+)$/)?.[1];
  if (method === 'GET' && modelIdMatch) {
    const record = await client.modelProfile.findUnique({ where: { id: modelIdMatch }, include: { dataset: true, evaluations: { orderBy: { createdAt: 'desc' } } } });
    if (!record) deny(404, 'Model not found in an assigned case.', 'model_not_found'); await accessibleCase(client, actor, record.dataset.caseId);
    return result(200, { model: { ...modelProfileDto(record), evaluations: record.evaluations.map((item) => ({ id: item.id, metrics: parseStoredJson(item.metricsJson), splitStrategy: item.splitStrategy, evaluationRef: item.evaluationRef, status: item.status, evaluatedBy: item.evaluatedBy, createdAt: item.createdAt })) } });
  }
  if (method === 'POST' && path === '/api/models') {
    requireRole(actor, ['administrator']); const dataset = await client.trainingDataset.findUnique({ where: { id: body.datasetId } }); if (!dataset) deny(404, 'Training dataset not found in an assigned case.', 'training_dataset_not_found'); await accessibleCase(client, actor, dataset.caseId, true);
    const task = requireText(body.task, 'Model task', 80); const provider = requireText(body.provider, 'Model provider', 80); const status = body.status || 'evaluation';
    if (!modelTasks.has(task) || task !== dataset.task || !modelProviders.has(provider)) deny(422, 'A registered model must use a supported provider and match its dataset task.', 'invalid_model_profile');
    if (!modelStatuses.has(status)) deny(422, 'The model status is not supported.', 'invalid_model_status');
    if (status !== 'evaluation') deny(422, 'New models must begin in evaluation. Pilot approval requires a separately recorded evaluation and explicit administrator approval.', 'model_must_begin_evaluation');
    const metrics = parseObject(body.metrics || {}, 'Evaluation metrics');
    const record = await client.modelProfile.create({ data: { id: id('model'), datasetId: dataset.id, name: requireText(body.name, 'Model name', 140), provider, task, version: requireText(body.version, 'Model version', 120), status, metricsJson: JSON.stringify(metrics), approvalRef: requireText(body.approvalRef, 'Model registration reference', 240), endpointReference: body.endpointReference?.trim() || null } });
    await appendAudit(client, actor, 'ai.model.registered', record.id, { caseId: dataset.caseId, datasetId: dataset.id, task: record.task, provider: record.provider, modelVersion: record.version, status: record.status });
    return result(201, { model: modelProfileDto(record) });
  }
  const modelApproveId = path.match(/^\/api\/models\/([^/]+)\/approve$/)?.[1];
  if (method === 'POST' && modelApproveId) {
    requireRole(actor, ['administrator']); const model = await client.modelProfile.findUnique({ where: { id: modelApproveId }, include: { dataset: true, evaluations: true } }); if (!model) deny(404, 'Model not found in an assigned case.', 'model_not_found'); const caseRecord = await accessibleCase(client, actor, model.dataset.caseId, true);
    const approvalExpiresAt = new Date(body.approvalExpiresAt);
    if (Number.isNaN(approvalExpiresAt.valueOf()) || approvalExpiresAt <= now() || approvalExpiresAt > caseRecord.expiresAt || !body.approvalRef?.trim() || !model.evaluations.some((evaluation) => evaluation.status === 'accepted')) deny(422, 'Approval requires a separately accepted evaluation, a documented approval reference, and an unexpired approval within the active case.', 'model_approval_incomplete');
    const record = await client.modelProfile.update({ where: { id: model.id }, data: { status: 'approved_for_pilot', approvalRef: body.approvalRef.trim(), metricsJson: JSON.stringify(parseObject(body.metrics || model.metricsJson, 'Evaluation metrics')), approvedAt: now(), approvedBy: actor.id, approvalExpiresAt } });
    await appendAudit(client, actor, 'ai.model.approved', record.id, { caseId: caseRecord.id, modelId: record.id, modelVersion: record.version, provider: record.provider, approvalExpiresAt: record.approvalExpiresAt });
    return result(200, { model: modelProfileDto(record) });
  }
  const modelRetireId = path.match(/^\/api\/models\/([^/]+)\/retire$/)?.[1];
  if (method === 'POST' && modelRetireId) {
    requireRole(actor, ['administrator']); const model = await client.modelProfile.findUnique({ where: { id: modelRetireId }, include: { dataset: true } }); if (!model) deny(404, 'Model not found in an assigned case.', 'model_not_found'); await accessibleCase(client, actor, model.dataset.caseId);
    const record = await client.modelProfile.update({ where: { id: model.id }, data: { status: 'retired', approvalExpiresAt: now() } });
    await appendAudit(client, actor, 'ai.model.retired', record.id, { caseId: model.dataset.caseId, modelId: record.id, modelVersion: record.version, provider: record.provider, reason: body.reason?.trim() || 'No reason supplied.' });
    return result(200, { model: modelProfileDto(record) });
  }
  const modelEvaluationId = path.match(/^\/api\/models\/([^/]+)\/evaluations$/)?.[1];
  if (method === 'POST' && modelEvaluationId) {
    requireRole(actor, ['supervisor', 'administrator']); const model = await client.modelProfile.findUnique({ where: { id: modelEvaluationId }, include: { dataset: true } }); if (!model) deny(404, 'Model not found in an assigned case.', 'model_not_found'); await accessibleCase(client, actor, model.dataset.caseId, true);
    const record = await client.modelEvaluation.create({ data: { id: id('model_evaluation'), modelId: model.id, datasetId: model.datasetId, metricsJson: JSON.stringify(parseObject(body.metrics, 'Evaluation metrics')), splitStrategy: requireText(body.splitStrategy, 'Dataset split strategy', 1000), evaluationRef: requireText(body.evaluationRef, 'Evaluation reference', 240), status: body.status === 'accepted' ? 'accepted' : 'recorded', evaluatedBy: actor.id } });
    await appendAudit(client, actor, 'ai.model.evaluated', record.id, { caseId: model.dataset.caseId, modelId: model.id, modelVersion: model.version, evaluationRef: record.evaluationRef });
    return result(201, { evaluation: { ...record, metrics: parseStoredJson(record.metricsJson) } });
  }
  if (method === 'GET' && path === '/api/model-findings') {
    const caseId = url.searchParams.get('caseId'); await accessibleCase(client, actor, caseId);
    const records = await client.modelFinding.findMany({ where: { caseId }, include: { model: true }, orderBy: { createdAt: 'desc' } });
    return result(200, { findings: records.map((record) => modelFindingDto(record, true)) });
  }
  if (method === 'POST' && path === '/api/model-findings') {
    requireRole(actor, ['operator', 'supervisor', 'administrator']); const caseRecord = await accessibleCase(client, actor, body.caseId, true); const model = await client.modelProfile.findUnique({ where: { id: body.modelId }, include: { dataset: true } });
    if (!model || model.dataset.caseId !== caseRecord.id || !isModelEligible(model) || model.task !== body.task) deny(403, 'Only a case-approved, unexpired pilot model matching this task may submit a finding.', 'model_not_authorized');
    let placeLead = null;
    if (body.placeLeadId) { placeLead = await client.placeLead.findUnique({ where: { id: body.placeLeadId } }); if (!placeLead || placeLead.caseId !== caseRecord.id) deny(403, 'The linked place lead is not assigned to this case.', 'case_access_denied'); }
    const sourceHash = requireText(body.sourceHash, 'Source SHA-256 hash', 128);
    if (placeLead && sourceHash !== placeLead.sourceHash) deny(422, 'The finding source hash must match its linked place lead.', 'source_integrity_mismatch');
    const evidence = validateModelEvidence(body.evidence); const scores = scoreModelEvidence(evidence);
    const record = await client.modelFinding.create({ data: { id: id('model_finding'), caseId: caseRecord.id, placeLeadId: placeLead?.id || null, modelId: model.id, sourceHash, task: model.task, evidenceJson: JSON.stringify(evidence), confidence: scores.confidence, evidenceScore: scores.evidenceScore, status: 'pending_review', explanation: body.explanation?.trim() || null, provider: model.provider, modelVersion: model.version, recommendation: 'review_required' } });
    await appendAudit(client, actor, 'ai.model.finding.created', record.id, { caseId: record.caseId, modelId: record.modelId, modelVersion: model.version, provider: model.provider, task: record.task, evidenceScore: record.evidenceScore, signalTypes: [...new Set(evidence.map((signal) => signal.type))] });
    return result(202, { disposition: 'pending_human_review', finding: modelFindingDto(record) });
  }
  const modelFindingReviewId = path.match(/^\/api\/model-findings\/([^/]+)\/review$/)?.[1];
  if (method === 'POST' && modelFindingReviewId) {
    requireRole(actor, ['reviewer', 'supervisor', 'administrator']); const finding = await client.modelFinding.findUnique({ where: { id: modelFindingReviewId } }); if (!finding) deny(404, 'Model finding not found in an assigned case.', 'model_finding_not_found'); await accessibleCase(client, actor, finding.caseId);
    if (!['approve', 'reject', 'escalate'].includes(body.decision) || !body.reason?.trim()) deny(422, 'A review decision and written reasoning are required.', 'validation_failed'); if (finding.status !== 'pending_review') deny(409, 'This model finding has already been reviewed.', 'already_reviewed');
    const record = await client.modelFinding.update({ where: { id: finding.id }, data: { status: body.decision === 'approve' ? 'accepted_for_case' : body.decision === 'reject' ? 'rejected' : 'escalated', reviewerReason: body.reason.trim(), reviewedAt: now(), reviewedBy: actor.id } });
    await appendAudit(client, actor, 'ai.model.finding.reviewed', record.id, { caseId: record.caseId, modelId: record.modelId, modelVersion: finding.modelVersion, provider: finding.provider, decision: body.decision, reason: record.reviewerReason });
    return result(200, { finding: modelFindingDto(record) });
  }

  if (method === 'GET' && path === '/api/audit') {
    const caseId = url.searchParams.get('caseId'); await accessibleCase(client, actor, caseId);
    const records = await client.auditLog.findMany({ orderBy: { at: 'desc' }, take: 12 });
    return result(200, { records: records.filter((record) => { const detail = JSON.parse(record.detailJson); return detail.caseId === caseId || record.resource === caseId; }).reverse().map(({ detailJson, ...record }) => record) });
  }
  if (method === 'GET' && path === '/api/cases') {
    const records = await client.investigationCase.findMany({ orderBy: { createdAt: 'desc' } });
    return result(200, { cases: records.filter((record) => record.permittedRoles.split(',').includes(actor.role)).map(caseDto) });
  }
  if (method === 'POST' && path === '/api/cases') {
    requireRole(actor, ['operator', 'supervisor', 'administrator']);
    const expiresAt = new Date(body.expiresAt);
    if (!body.caseNumber || !body.title || !body.authorityRef || Number.isNaN(expiresAt.valueOf()) || expiresAt <= now()) deny(422, 'A future expiry, case number, title, and documented authority reference are required.', 'validation_failed');
    const record = await client.investigationCase.create({ data: { id: id('case'), caseNumber: body.caseNumber, title: body.title, authorityRef: body.authorityRef, expiresAt, accessScope: body.accessScope || 'named-partner-scope', status: 'active', permittedRoles: 'operator,reviewer,supervisor,administrator' } });
    await appendAudit(client, actor, 'case.created', record.id, { caseId: record.id, caseNumber: record.caseNumber, authorityRef: record.authorityRef }); return result(201, { case: caseDto(record) });
  }
  if (method === 'GET' && path === '/api/watchlists') {
    const caseId = url.searchParams.get('caseId'); if (caseId) await accessibleCase(client, actor, caseId);
    const records = await client.watchlist.findMany({ where: caseId ? { caseId } : {} }); return result(200, { watchlists: records.map(watchlistDto) });
  }
  if (method === 'POST' && path === '/api/watchlists') {
    requireRole(actor, ['operator', 'supervisor', 'administrator']); const caseRecord = await accessibleCase(client, actor, body.caseId, true); const expiresAt = new Date(body.expiresAt);
    if (!body.plate || Number.isNaN(expiresAt.valueOf()) || expiresAt > caseRecord.expiresAt || expiresAt <= now()) deny(422, 'A plate and expiry no later than the case expiry are required.', 'validation_failed');
    const record = await client.watchlist.create({ data: { id: id('watch'), caseId: body.caseId, plate: body.plate, plateNormalized: normalizePlate(body.plate), vehicleMake: body.vehicle?.make, vehicleModel: body.vehicle?.model, vehicleColor: body.vehicle?.color, vehicleType: body.vehicle?.type, expiresAt, accessScope: body.accessScope || caseRecord.accessScope, status: 'active' } });
    await appendAudit(client, actor, 'watchlist.created', record.id, { caseId: record.caseId, expiresAt: record.expiresAt }); return result(201, { watchlist: watchlistDto(record) });
  }
  if (method === 'GET' && path === '/api/cameras') return result(200, { cameras: (await client.camera.findMany()).map(cameraDto) });
  if (method === 'POST' && path === '/api/cameras') {
    requireRole(actor, ['administrator']);
    if (!body.name || !body.owner || typeof body.location?.lat !== 'number' || typeof body.location?.lng !== 'number' || !body.direction || !body.authorizationRef || !body.retentionDays) deny(422, 'Camera location, direction, owner, retention policy, and authorization record are mandatory.', 'validation_failed');
    const record = await client.camera.create({ data: { id: id('cam'), name: body.name, owner: body.owner, sourceType: body.sourceType || 'partner_upload', status: 'registered', direction: body.direction, latitude: body.location.lat, longitude: body.location.lng, locationLabel: body.location.label || 'Pending partner confirmation', retentionDays: Number(body.retentionDays), authorizationRef: body.authorizationRef, authorizationExpiresAt: body.authorizationExpiresAt ? new Date(body.authorizationExpiresAt) : null } });
    await appendAudit(client, actor, 'camera.registered', record.id, { authorizationRef: record.authorizationRef, owner: record.owner }); return result(201, { camera: cameraDto(record) });
  }
  if (method === 'POST' && path === '/api/edge/register') {
    requireRole(actor, ['administrator']); if (!body.name || !Array.isArray(body.scopes) || !body.scopes.length) deny(422, 'An agent name and one or more authorized scopes are required.', 'validation_failed');
    const enrollmentKey = `edge_${randomUUID().replaceAll('-', '')}`; const record = await client.edgeAgent.create({ data: { id: id('agent'), name: body.name, status: 'registered', scopes: body.scopes.join(','), keyHash: hash(enrollmentKey) } });
    await appendAudit(client, actor, 'edge_agent.registered', record.id, { scopes: body.scopes }); return result(201, { agent: { ...record, keyHash: undefined }, enrollmentKey });
  }
  if (method === 'POST' && path === '/api/edge/heartbeat') {
    const agent = await client.edgeAgent.findUnique({ where: { keyHash: hash(headers['x-edge-key'] || '') } }); if (!agent) deny(401, 'An enrolled edge-agent key is required.', 'edge_auth_failed');
    const record = await client.edgeAgent.update({ where: { id: agent.id }, data: { status: body.status || 'online', lastHeartbeatAt: now() } }); await appendAudit(client, { id: `edge:${agent.id}`, role: 'edge_agent' }, 'edge_agent.heartbeat', agent.id, { status: record.status }); return result(200, { accepted: true, nextHeartbeatSeconds: 60 });
  }
  if (method === 'POST' && path === '/api/edge/events') {
    const agent = await client.edgeAgent.findUnique({ where: { keyHash: hash(headers['x-edge-key'] || '') } }); if (!agent) deny(401, 'An enrolled edge-agent key is required.', 'edge_auth_failed');
    if (body.type !== 'possible_match') deny(422, 'Only policy-filtered possible_match events may be submitted. Vehicle detections without an active case must remain at the edge.', 'event_type_not_allowed');
    if (!body.eventId || !body.caseId || !body.watchlistId || !body.cameraId || !body.evidence?.id || !body.evidence?.checksum || body.rawFootage || body.frame) deny(422, 'A deduplicable event, active watchlist, camera, and encrypted evidence reference are required. Raw frames or footage are not accepted.', 'validation_failed');
    const caseRecord = await client.investigationCase.findUnique({ where: { id: body.caseId } }); const watchlist = await client.watchlist.findUnique({ where: { id: body.watchlistId } }); const camera = await client.camera.findUnique({ where: { id: body.cameraId } });
    if (!caseRecord || caseRecord.status !== 'active' || caseRecord.expiresAt <= now() || !watchlist || watchlist.caseId !== body.caseId || watchlist.status !== 'active' || watchlist.expiresAt <= now() || !camera || !agent.scopes.split(',').includes(caseRecord.accessScope)) deny(403, 'This event is outside an active, authorized case, camera, or agent scope.', 'event_out_of_scope');
    const duplicate = await client.sighting.findUnique({ where: { eventId: body.eventId } }); if (duplicate) return result(202, { accepted: true, duplicate: true, sightingId: duplicate.id });
    const record = await client.sighting.create({ data: { id: id('sighting'), eventId: body.eventId, caseId: body.caseId, watchlistId: body.watchlistId, cameraId: body.cameraId, capturedAt: body.capturedAt ? new Date(body.capturedAt) : now(), confidence: Number(body.confidence || 0), plateRead: body.plateRead || null, direction: body.direction || camera.direction, status: 'pending_review', routeState: 'possible_lead', evidenceId: body.evidence.id, evidenceKind: body.evidence.kind || 'encrypted_clip_reference', evidenceChecksum: body.evidence.checksum, evidenceRetentionUntil: body.evidence.retentionUntil ? new Date(body.evidence.retentionUntil) : caseRecord.expiresAt } });
    await appendAudit(client, { id: `edge:${agent.id}`, role: 'edge_agent' }, 'candidate.submitted', record.id, { caseId: record.caseId, cameraId: record.cameraId, confidence: record.confidence }); return result(202, { accepted: true, sightingId: record.id, disposition: 'pending_human_review' });
  }
  if (method === 'GET' && path === '/api/sightings') {
    const caseId = url.searchParams.get('caseId'); await accessibleCase(client, actor, caseId); const records = await client.sighting.findMany({ where: { caseId }, include: { camera: true }, orderBy: { capturedAt: 'desc' } }); return result(200, { sightings: records.map((record) => sightingDto(record, true)) });
  }
  if (method === 'GET' && path === '/api/review-queue') {
    requireRole(actor, ['reviewer', 'supervisor', 'administrator']); const caseId = url.searchParams.get('caseId'); if (caseId) await accessibleCase(client, actor, caseId); const records = await client.sighting.findMany({ where: { status: 'pending_review', ...(caseId ? { caseId } : {}) }, include: { camera: true, watchlist: true }, orderBy: { capturedAt: 'asc' } }); return result(200, { candidates: records.map((record) => ({ ...sightingDto(record, true), watchlist: watchlistDto(record.watchlist) })) });
  }
  const reviewId = path.match(/^\/api\/sightings\/([^/]+)\/review$/)?.[1];
  if (method === 'POST' && reviewId) {
    requireRole(actor, ['reviewer', 'supervisor', 'administrator']); const sighting = await client.sighting.findUnique({ where: { id: reviewId } }); if (!sighting) deny(404, 'Candidate not found in an assigned case.', 'candidate_not_found'); await accessibleCase(client, actor, sighting.caseId);
    if (!['approve', 'reject', 'escalate'].includes(body.decision) || !body.reason?.trim()) deny(422, 'A review decision and reviewer reasoning are required.', 'validation_failed'); if (sighting.status !== 'pending_review') deny(409, 'This candidate has already been reviewed.', 'already_reviewed');
    const record = await client.sighting.update({ where: { id: sighting.id }, data: { status: body.decision === 'approve' ? 'verified' : body.decision === 'reject' ? 'rejected' : 'escalated', routeState: body.decision === 'approve' ? 'observed' : 'possible_lead', reviewerReason: body.reason.trim(), reviewedBy: actor.id, reviewedAt: now() } }); await appendAudit(client, actor, `candidate.${body.decision}d`, record.id, { caseId: record.caseId, reason: record.reviewerReason }); return result(200, { sighting: sightingDto(record) });
  }
  if (method === 'POST' && path === '/api/search-jobs') {
    requireRole(actor, ['operator', 'supervisor', 'administrator']); const caseRecord = await accessibleCase(client, actor, body.caseId, true); if (!body.reference?.evidenceId || !body.reference?.checksum) deny(422, 'Reference-media searches require an active authorized case and an evidence-storage reference; direct third-party capture is prohibited.', 'unauthorized_search');
    const record = await client.searchJob.create({ data: { id: id('job'), caseId: body.caseId, status: 'queued', evidenceId: body.reference.evidenceId, evidenceChecksum: body.reference.checksum, scope: body.scope || caseRecord.accessScope } }); await appendAudit(client, actor, 'search_job.created', record.id, { caseId: record.caseId, scope: record.scope }); return result(202, { job: { ...record, reference: { evidenceId: record.evidenceId, checksum: record.evidenceChecksum }, limits: { activeCaseOnly: record.activeCaseOnly, authorizedFeedsOnly: record.authorizedFeedsOnly, reviewerRequired: record.reviewerRequired } } });
  }
  if (method === 'GET' && path.startsWith('/api/search-jobs/')) {
    const record = await client.searchJob.findUnique({ where: { id: path.split('/').at(-1) } }); if (!record) deny(404, 'Search job not found.', 'job_not_found'); await accessibleCase(client, actor, record.caseId); return result(200, { job: { ...record, reference: { evidenceId: record.evidenceId, checksum: record.evidenceChecksum } } });
  }
  if (method === 'POST' && path === '/api/media-receipts') {
    requireRole(actor, ['operator', 'supervisor', 'administrator']); await accessibleCase(client, actor, body.caseId, true); if (!body.storageReference || !body.checksum || !body.submitterAuthority) deny(422, 'A case, approved-storage reference, checksum, and documented submitter authority are required.', 'validation_failed');
    const record = await client.mediaReceipt.create({ data: { id: id('receipt'), caseId: body.caseId, storageReference: body.storageReference, checksum: body.checksum, submitterAuthority: body.submitterAuthority } }); await appendAudit(client, actor, 'media.receipt_recorded', record.id, { caseId: record.caseId, checksum: record.checksum }); return result(201, { receipt: record });
  }
  if (method === 'GET' && path === '/api/map-layer') {
    const caseId = url.searchParams.get('caseId'); await accessibleCase(client, actor, caseId); const includeAll = url.searchParams.get('include') === 'all' && ['reviewer', 'supervisor', 'administrator'].includes(actor.role); const records = await client.sighting.findMany({ where: { caseId, ...(includeAll ? { status: { in: ['verified', 'pending_review', 'escalated'] } } : { status: 'verified' }) }, include: { camera: true }, orderBy: { capturedAt: 'asc' } }); return result(200, { label: 'Investigative leads only — not a real-time location service.', sightings: records.map(mapSighting) });
  }
  const evidenceId = path.match(/^\/api\/evidence\/([^/]+)$/)?.[1];
  if (method === 'GET' && evidenceId) {
    const record = await client.sighting.findFirst({ where: { evidenceId } }); if (!record) deny(404, 'Evidence is not available for this case.', 'evidence_not_found'); await accessibleCase(client, actor, record.caseId); await appendAudit(client, actor, 'evidence.accessed', evidenceId, { caseId: record.caseId, sightingId: record.id }); return result(200, { evidence: { ...sightingDto(record).evidence, disposition: 'Controlled evidence reference only. Retrieve encrypted source through the approved evidence vault.' } });
  }
  if (method === 'GET' && path === '/api/audit/export') {
    requireRole(actor, ['supervisor', 'administrator']); const caseId = url.searchParams.get('caseId'); if (caseId) await accessibleCase(client, actor, caseId); const records = await client.auditLog.findMany({ orderBy: { at: 'asc' } }); const scoped = records.filter((record) => { const detail = JSON.parse(record.detailJson); return !caseId || detail.caseId === caseId || record.resource === caseId; }); await appendAudit(client, actor, 'audit.exported', caseId || 'all', { caseId: caseId || 'all', records: scoped.length }); return { status: 200, raw: scoped.map((record) => JSON.stringify(record)).join('\n'), headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'content-disposition': `attachment; filename="audit-${caseId || 'all'}.ndjson"`, 'cache-control': 'no-store' } };
  }
  deny(404, 'Endpoint not found.', 'not_found');
}

async function readNodeBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maxJsonBodyBytes) deny(422, 'Request body is too large. Image place analysis accepts at most a 5 MB image; upload raw footage to approved evidence storage and submit only its reference.', 'validation_failed'); chunks.push(chunk); }
  if (!chunks.length) return {}; try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { deny(422, 'Request body must be valid JSON.', 'validation_failed'); }
}

// Retained as a small native HTTP adapter for API integration tests. The production app uses Next route handlers.
export function createApp({ client = defaultPrisma } = {}) {
  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`); const body = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await readNodeBody(request) : {}; const output = await handleApi({ method: request.method, headers: request.headers, body }, url, client); response.writeHead(output.status, { 'content-type': 'application/json; charset=utf-8', ...output.headers }); response.end(output.raw ?? JSON.stringify(output.body));
    } catch (error) {
      const status = error.status || (error instanceof HttpError ? error.status : 500); const payload = { error: { code: error.code || 'internal_error', message: error.message || 'The service could not complete this request.' } }; response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(payload));
    }
  });
}
