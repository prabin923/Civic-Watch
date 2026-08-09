import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { prisma } from '../lib/prisma.js';
import { createApp, normalizePlaceDetection, resetAndSeed } from '../lib/platform.js';
import { matchPilotGazetteer } from '../lib/pilot-gazetteer.js';
import { isTrainingExampleEligible, validateGroundedReasoning } from '../lib/ai/index.js';
import { createVertexProvider } from '../lib/ai/providers/vertex.js';

let server; let base;
const approvedLocalNominatim = (configured) => {
  if (!configured) return false;
  try {
    const endpoint = new URL(configured);
    return ['http:', 'https:'].includes(endpoint.protocol) && endpoint.hostname.toLowerCase() !== 'nominatim.openstreetmap.org';
  } catch {
    return false;
  }
};
const request = async (path, options = {}, role = 'administrator') => {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', 'x-demo-role': role, 'x-demo-user': `test.${role}`, ...(options.headers || {}) } });
  const text = await response.text(); return { response, body: text ? JSON.parse(text) : null };
};

before(async () => { await resetAndSeed(prisma); server = createApp({ client: prisma }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await new Promise((resolve) => server.close(resolve)); await resetAndSeed(prisma); await prisma.$disconnect(); });

test('health, local place-analysis configuration, and active cases are available', async () => { const health = await request('/api/health', {}, 'operator'); assert.equal(health.response.status, 200); assert.equal(health.body.status, 'ok'); assert.equal(health.body.persistence, 'prisma-sqlite'); const config = await request('/api/config', {}, 'operator'); const googleFallback = process.env.PLACE_ANALYSIS_GOOGLE_FALLBACK === 'true' || process.env.PLACE_ANALYSIS_PROVIDER === 'google_vision'; const pilotGazetteerEnabled = process.env.DEMO_MODE === 'true'; const localGeocoderEnabled = approvedLocalNominatim(process.env.LOCAL_NOMINATIM_URL); assert.equal(config.body.demoMode, true); assert.deepEqual(config.body.maps, { provider: 'google_maps', enabled: false, browserKey: null }); assert.deepEqual(config.body.placeDetection, { metadataEnabled: true, localOcrEnabled: process.env.LOCAL_TESSERACT_ENABLED !== 'false', pilotGazetteerEnabled, localGeocoderEnabled, googleVisionFallbackEnabled: googleFallback && Boolean(process.env.GOOGLE_VISION_API_KEY), landmarkProviderEnabled: googleFallback && Boolean(process.env.GOOGLE_VISION_API_KEY), reverseGeocodingEnabled: localGeocoderEnabled || (googleFallback && Boolean(process.env.GOOGLE_GEOCODING_API_KEY || process.env.GOOGLE_MAPS_SERVER_KEY || process.env.GOOGLE_VISION_API_KEY)), providerMode: googleFallback ? 'local_with_google_fallback' : pilotGazetteerEnabled ? 'local_pilot_gazetteer' : 'local_only', maxImageBytes: 5 * 1024 * 1024 }); const cases = await request('/api/cases', {}, 'operator'); assert.equal(cases.body.cases[0].caseNumber, 'KTM-2026-0817'); });
test('the offline Kathmandu pilot gazetteer is bounded to recognised MVP landmark names', () => { const match = matchPilotGazetteer('KATHMANDU DURBAR SQUARE entrance'); assert.equal(match?.name, 'Kathmandu Durbar Square'); assert.equal(match?.address, 'Kathmandu Durbar Square, Kathmandu 44600, Nepal'); assert.equal(matchPilotGazetteer('unrelated street text'), null); });
test('incomplete place-provider output is converted to a no-result rather than a location lead', () => {
  const noResult = normalizePlaceDetection({ sourceKind: 'landmark_analysis', provider: 'test-provider', label: 'Incomplete candidate', confidence: 0.84, latitude: null, longitude: null, explanation: 'Missing coordinate.' });
  assert.equal(noResult.sourceKind, 'no_location_signal');
  assert.equal(noResult.latitude, null);
  assert.equal(noResult.longitude, null);
  assert.match(noResult.explanation, /incomplete location evidence/i);
});
test('auth sessions protect the console and can be revoked', async () => { const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@civicwatch.local', password: 'CivicWatchDemo!2026' }) }); assert.equal(login.response.status, 200); const cookie = login.response.headers.get('set-cookie'); assert.ok(cookie?.includes('civicwatch_session=')); const me = await request('/api/auth/me', { headers: { cookie } }, 'operator'); assert.equal(me.body.user.email, 'admin@civicwatch.local'); assert.equal(me.body.user.role, 'administrator'); const protectedConfig = await request('/api/config', { headers: { cookie } }, 'reviewer'); assert.equal(protectedConfig.response.status, 200); const logout = await request('/api/auth/logout', { method: 'POST', headers: { cookie } }, 'operator'); assert.equal(logout.body.signedOut, true); const afterLogout = await request('/api/auth/me', { headers: { cookie } }, 'operator'); assert.equal(afterLogout.response.status, 401); });
test('synthetic demo reset is administrator-only and restores a presentable route scenario', async () => { const denied = await request('/api/demo/reset', { method: 'POST', body: '{}' }, 'operator'); assert.equal(denied.response.status, 403); const restored = await request('/api/demo/reset', { method: 'POST', body: '{}' }, 'administrator'); assert.equal(restored.body.scenario, 'synthetic-kathmandu-vehicle-route'); const map = await request('/api/map-layer?caseId=case_KTM_0817&include=all', {}, 'reviewer'); assert.equal(map.body.sightings.length, 3); assert.equal(map.body.sightings.filter((item) => item.status === 'verified').length, 2); assert.equal(map.body.sightings.filter((item) => item.status === 'pending_review').length, 1); });
test('image place leads are case-scoped, synthetic-demo capable, and reviewer-gated', async () => { const denied = await request('/api/place-leads', { method: 'POST', body: JSON.stringify({ caseId: 'case_KTM_0817', demo: true }) }, 'reviewer'); assert.equal(denied.response.status, 403); const created = await request('/api/place-leads', { method: 'POST', body: JSON.stringify({ caseId: 'case_KTM_0817', demo: true }) }, 'operator'); assert.equal(created.response.status, 202); assert.equal(created.body.disposition, 'pending_human_review'); assert.equal(created.body.placeLead.sourceKind, 'synthetic_demo'); assert.equal(created.body.placeLead.address, 'Kathmandu Durbar Square, Kathmandu 44600, Nepal'); assert.equal(created.body.placeLead.status, 'pending_review'); const list = await request('/api/place-leads?caseId=case_KTM_0817', {}, 'reviewer'); const lead = list.body.placeLeads.find((item) => item.id === created.body.placeLead.id); assert.ok(lead); assert.equal(lead.label, lead.address); const approved = await request(`/api/place-leads/${lead.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'approve', reason: 'Synthetic scenario reviewed against its documented demo context.' }) }, 'reviewer'); assert.equal(approved.response.status, 200); assert.equal(approved.body.placeLead.status, 'verified'); assert.equal(JSON.stringify(approved.body).includes('imageBase64'), false); });
test('an authorized image with no supported location signal remains only an audited no-result', async () => { const configuredKey = process.env.GOOGLE_VISION_API_KEY; delete process.env.GOOGLE_VISION_API_KEY; let response; try { response = await request('/api/place-leads', { method: 'POST', body: JSON.stringify({ caseId: 'case_KTM_0817', imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg', filename: 'no-location.jpg', submitterAuthority: 'Test evidence receipt' }) }, 'operator'); } finally { if (configuredKey) process.env.GOOGLE_VISION_API_KEY = configuredKey; } assert.equal(response.response.status, 202); assert.equal(response.body.disposition, 'no_location_signal'); const list = await request('/api/place-leads?caseId=case_KTM_0817', {}, 'reviewer'); assert.equal(list.body.placeLeads.some((item) => item.sourceFilename === 'no-location.jpg'), false); });
test('unexpected place-analysis input failures never leak internal property errors', async () => {
  const response = await request('/api/place-leads', { method: 'POST', body: JSON.stringify({ caseId: 'case_KTM_0817', imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg', filename: 'invalid-authority.jpg', submitterAuthority: {} }) }, 'operator');
  assert.equal(response.response.status, 422);
  assert.equal(response.body.error.code, 'place_analysis_failed');
  assert.doesNotMatch(response.body.error.message, /cannot read properties|reading 'id'/i);
});
test('watchlists require an active authorized case and cannot outlive it', async () => { const denied = await request('/api/watchlists', { method: 'POST', body: JSON.stringify({ caseId: 'missing', plate: 'BA 10 CHA 1234', expiresAt: '2026-12-01T00:00:00Z' }) }, 'operator'); assert.equal(denied.response.status, 403); const tooLong = await request('/api/watchlists', { method: 'POST', body: JSON.stringify({ caseId: 'case_KTM_0817', plate: 'BA 10 CHA 1234', expiresAt: '2026-12-01T00:00:00Z' }) }, 'operator'); assert.equal(tooLong.response.status, 422); });
test('edge events are reviewer-gated, idempotent, and only approved candidates become verified map sightings', async () => { const event = { eventId: 'evt_test_review_gate', type: 'possible_match', caseId: 'case_KTM_0817', watchlistId: 'watch_4421', cameraId: 'cam_thamel_01', capturedAt: '2026-08-07T09:00:00Z', confidence: .88, plateRead: 'BA 13 PA 4421', evidence: { id: 'evidence_test_gate', kind: 'encrypted_clip_reference', checksum: 'abcd1234' } }; const created = await request('/api/edge/events', { method: 'POST', headers: { 'x-edge-key': 'demo-edge-key' }, body: JSON.stringify(event) }); assert.equal(created.response.status, 202); assert.equal(created.body.disposition, 'pending_human_review'); const duplicate = await request('/api/edge/events', { method: 'POST', headers: { 'x-edge-key': 'demo-edge-key' }, body: JSON.stringify(event) }); assert.equal(duplicate.body.duplicate, true);
  const beforeApproval = await request('/api/map-layer?caseId=case_KTM_0817', {}, 'reviewer'); assert.equal(beforeApproval.body.sightings.some((item) => item.id === created.body.sightingId), false); const review = await request(`/api/sightings/${created.body.sightingId}/review`, { method: 'POST', body: JSON.stringify({ decision: 'approve', reason: 'Plate and vehicle attributes match; evidence reference checksum received.' }) }, 'reviewer'); assert.equal(review.body.sighting.status, 'verified'); const afterApproval = await request('/api/map-layer?caseId=case_KTM_0817', {}, 'reviewer'); assert.equal(afterApproval.body.sightings.some((item) => item.id === created.body.sightingId), true); });
test('review decisions require a reviewer role and documented reasoning', async () => { const queue = await request('/api/review-queue?caseId=case_KTM_0817', {}, 'reviewer'); const candidate = queue.body.candidates[0]; assert.ok(candidate); const denied = await request(`/api/sightings/${candidate.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'reject', reason: 'bad role attempt' }) }, 'operator'); assert.equal(denied.response.status, 403); const noReason = await request(`/api/sightings/${candidate.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'reject' }) }, 'reviewer'); assert.equal(noReason.response.status, 422); });

test('case audit metadata is visible to assigned case roles without exposing evidence references', async () => { const audit = await request('/api/audit?caseId=case_KTM_0817', {}, 'reviewer'); assert.equal(audit.response.status, 200); assert.ok(audit.body.records.length > 0); assert.equal(JSON.stringify(audit.body.records).includes('encrypted_clip_reference'), false); });

test('training data, Vertex handoff, and model findings remain case-scoped and reviewer-gated', async () => {
  const datasets = await request('/api/training/datasets?caseId=case_KTM_0817', {}, 'operator');
  assert.equal(datasets.response.status, 200);
  const placeDataset = datasets.body.datasets.find((item) => item.task === 'place_geolocation');
  assert.ok(placeDataset);
  const deniedExport = await request(`/api/training/datasets/${placeDataset.id}/vertex-manifest`, {}, 'reviewer');
  assert.equal(deniedExport.response.status, 403);
  const submitted = await request(`/api/training/datasets/${placeDataset.id}/examples`, { method: 'POST', body: JSON.stringify({ sourceHash: 'test-training-place-hash', storageReference: 'gs://civicwatch-test/authorized/place-002.jpg', checksum: 'test-training-place-checksum', sourceFilename: 'place-002.jpg', mimeType: 'image/jpeg', submitterAuthority: 'TEST-AUTHORIZED-SUBMITTER', license: 'Synthetic test license', provenance: 'Controlled synthetic fixture with no external imagery.', authorizationRef: 'TEST-TRAINING-AUTHORIZATION', collectionTimestamp: new Date().toISOString(), retentionUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), annotation: { latitude: 27.7172, longitude: 85.324, landmark: 'Synthetic test label' } }) }, 'operator');
  assert.equal(submitted.response.status, 202);
  assert.equal(submitted.body.example.annotationStatus, 'pending_review');
  const pendingNotExported = await request(`/api/training/datasets/${placeDataset.id}/vertex-manifest`, {}, 'supervisor');
  assert.equal(pendingNotExported.response.status, 200);
  assert.equal(pendingNotExported.body.manifest.some((item) => item.sourceHash === 'test-training-place-hash'), false);
  const labelReview = await request(`/api/training-examples/${submitted.body.example.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'approve', reason: 'Synthetic test label reviewed for source integrity and coordinates.' }) }, 'reviewer');
  assert.equal(labelReview.response.status, 200);
  assert.equal(labelReview.body.example.annotationStatus, 'reviewer_verified');
  const exported = await request(`/api/training/datasets/${placeDataset.id}/vertex-manifest`, {}, 'supervisor');
  assert.equal(exported.response.status, 200);
  assert.ok(exported.body.manifest.some((item) => item.sourceHash === 'test-training-place-hash'));
  assert.equal(JSON.stringify(exported.body).includes('imageBase64'), false);
  const models = await request('/api/models?caseId=case_KTM_0817', {}, 'operator');
  const model = models.body.models.find((item) => item.task === 'place_geolocation' && item.status === 'approved_for_pilot');
  assert.ok(model);
  const leads = await request('/api/place-leads?caseId=case_KTM_0817', {}, 'reviewer');
  const lead = leads.body.placeLeads.find((item) => item.id === 'place_lead_001');
  assert.ok(lead);
  const finding = await request('/api/model-findings', { method: 'POST', body: JSON.stringify({ caseId: 'case_KTM_0817', modelId: model.id, task: 'place_geolocation', placeLeadId: lead.id, sourceHash: lead.sourceHash, evidence: [{ type: 'landmark', confidence: 0.78, claim: 'Synthetic landmark matches the reviewed test scenario.', source: 'test annotation' }, { type: 'map_context', confidence: 0.7, claim: 'Synthetic coordinates are consistent with the test map context.', source: 'test annotation' }], explanation: 'Synthetic test finding only; a reviewer must assess it.' }) }, 'operator');
  assert.equal(finding.response.status, 202);
  assert.equal(finding.body.finding.status, 'pending_review');
  assert.ok(finding.body.finding.evidenceScore < finding.body.finding.confidence);
  const wrongRole = await request(`/api/model-findings/${finding.body.finding.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'approve', reason: 'bad role attempt' }) }, 'operator');
  assert.equal(wrongRole.response.status, 403);
  const findingReview = await request(`/api/model-findings/${finding.body.finding.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'approve', reason: 'Synthetic evidence was reviewed against the documented demo scenario.' }) }, 'reviewer');
  assert.equal(findingReview.response.status, 200);
  assert.equal(findingReview.body.finding.status, 'accepted_for_case');
  const unchangedLead = await request('/api/place-leads?caseId=case_KTM_0817', {}, 'reviewer');
  assert.equal(unchangedLead.body.placeLeads.find((item) => item.id === lead.id).status, 'pending_review');
});

const aiSource = (suffix = 'vehicle') => ({ sourceHash: `test-ai-source-${suffix}`, storageReference: `gs://civicwatch-test/authorized/${suffix}.jpg`, mimeType: 'image/jpeg', authorizationRef: 'TEST-AI-EVIDENCE-AUTHORIZATION' });

test('CivicWatch AI enforces authentication, role, active-case, source, dataset, and model approval controls', async () => {
  const originalAuthRequired = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = 'true';
  try {
    const response = await fetch(`${base}/api/ai/vehicle-detection`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(response.status, 401, 'unauthorized AI request is rejected');
  } finally { if (originalAuthRequired === undefined) delete process.env.AUTH_REQUIRED; else process.env.AUTH_REQUIRED = originalAuthRequired; }

  const payload = { caseId: 'case_KTM_0817', modelId: 'model_vehicle_demo_01', source: aiSource('access-control') };
  const wrongRole = await request('/api/ai/vehicle-detection', { method: 'POST', body: JSON.stringify(payload) }, 'reviewer');
  assert.equal(wrongRole.response.status, 403, 'reviewer cannot initiate AI analysis');
  const wrongCase = await request('/api/ai/vehicle-detection', { method: 'POST', body: JSON.stringify({ ...payload, caseId: 'not-an-assigned-case' }) }, 'operator');
  assert.equal(wrongCase.response.status, 403, 'wrong case is rejected');
  const noHash = await request('/api/ai/vehicle-detection', { method: 'POST', body: JSON.stringify({ ...payload, source: { ...payload.source, sourceHash: '' } }) }, 'operator');
  assert.equal(noHash.response.status, 422, 'source hash is mandatory');
  const noAuthority = await request('/api/ai/vehicle-detection', { method: 'POST', body: JSON.stringify({ ...payload, source: { ...payload.source, authorizationRef: '' } }) }, 'operator');
  assert.equal(noAuthority.response.status, 422, 'source authorization is mandatory');

  await prisma.investigationCase.upsert({ where: { id: 'case_expired_ai_test' }, update: {}, create: { id: 'case_expired_ai_test', caseNumber: 'KTM-AI-EXPIRED', title: 'Expired AI test case', authorityRef: 'TEST-EXPIRED', accessScope: 'test-scope', expiresAt: new Date(Date.now() - 60_000), status: 'active', permittedRoles: 'operator,reviewer,supervisor,administrator' } });
  const expiredCase = await request('/api/ai/vehicle-detection', { method: 'POST', body: JSON.stringify({ ...payload, caseId: 'case_expired_ai_test' }) }, 'operator');
  assert.equal(expiredCase.response.status, 403, 'expired case cannot request AI');
  await prisma.investigationCase.upsert({ where: { id: 'case_other_ai_test' }, update: { expiresAt: new Date(Date.now() + 86_400_000), status: 'active' }, create: { id: 'case_other_ai_test', caseNumber: 'KTM-AI-OTHER', title: 'Other AI test case', authorityRef: 'TEST-OTHER', accessScope: 'test-scope', expiresAt: new Date(Date.now() + 86_400_000), status: 'active', permittedRoles: 'operator,reviewer,supervisor,administrator' } });
  const crossCase = await request('/api/ai/vehicle-detection', { method: 'POST', body: JSON.stringify({ ...payload, caseId: 'case_other_ai_test' }) }, 'operator');
  assert.equal(crossCase.response.status, 403, 'cross-case model use is rejected');

  const model = await prisma.modelProfile.findUnique({ where: { id: 'model_vehicle_demo_01' } });
  await prisma.modelProfile.update({ where: { id: model.id }, data: { status: 'evaluation' } });
  const unapproved = await request('/api/ai/vehicle-detection', { method: 'POST', body: JSON.stringify(payload) }, 'operator');
  assert.equal(unapproved.response.status, 403, 'unapproved model cannot create findings');
  await prisma.modelProfile.update({ where: { id: model.id }, data: { status: 'approved_for_pilot', approvedAt: new Date(), approvedBy: 'test.administrator', approvalRef: 'TEST-RESTORE', approvalExpiresAt: new Date(Date.now() + 86_400_000) } });
  await prisma.modelProfile.update({ where: { id: model.id }, data: { approvalExpiresAt: new Date(Date.now() - 60_000) } });
  const expiredModel = await request('/api/ai/vehicle-detection', { method: 'POST', body: JSON.stringify(payload) }, 'operator');
  assert.equal(expiredModel.response.status, 403, 'expired model approval cannot create findings');
  assert.equal(expiredModel.body.error.code, 'model_approval_expired');
  await prisma.modelProfile.update({ where: { id: model.id }, data: { approvalExpiresAt: new Date(Date.now() + 86_400_000) } });

  const dataset = await prisma.trainingDataset.findUnique({ where: { id: 'dataset_vehicle_kathmandu_v1' } });
  await prisma.trainingDataset.update({ where: { id: dataset.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  const expiredDatasetExample = await request(`/api/training/datasets/${dataset.id}/examples`, { method: 'POST', body: JSON.stringify({ sourceHash: 'expired-dataset-source', storageReference: 'gs://civicwatch-test/authorized/expired.jpg', checksum: 'expired-dataset-checksum', sourceFilename: 'expired.jpg', mimeType: 'image/jpeg', submitterAuthority: 'TEST-SUBMITTER', license: 'test', provenance: 'test', authorizationRef: 'TEST-AUTH', collectionTimestamp: new Date().toISOString(), retentionUntil: new Date(Date.now() + 3_600_000).toISOString(), annotation: { objects: [{ label: 'vehicle', box: { xMin: .1, yMin: .1, xMax: .8, yMax: .8 } }] } }) }, 'operator');
  assert.equal(expiredDatasetExample.response.status, 403, 'expired dataset rejects new examples');
  await prisma.trainingDataset.update({ where: { id: dataset.id }, data: { expiresAt: new Date(Date.now() + 86_400_000) } });
});

test('AI produces only pending case-scoped model findings and safely deduplicates replayed work', async () => {
  const sightingBefore = await request('/api/sightings?caseId=case_KTM_0817', {}, 'reviewer');
  const placeBefore = await request('/api/place-leads?caseId=case_KTM_0817', {}, 'reviewer');
  const payload = { caseId: 'case_KTM_0817', modelId: 'model_vehicle_demo_01', source: aiSource('dedupe'), structuredEvidence: { camera: { id: 'cam_thamel_01' }, ocr: [] }, correlationId: 'dedupe-ai-request-001' };
  const created = await request('/api/ai/vehicle-detection', { method: 'POST', body: JSON.stringify(payload) }, 'operator');
  assert.equal(created.response.status, 202);
  assert.equal(created.body.disposition, 'pending_human_review');
  assert.equal(created.body.finding.status, 'pending_review');
  assert.equal(created.body.finding.task, 'vehicle_detection');
  assert.equal(created.body.finding.recommendation, 'review_required');
  assert.equal(created.body.finding.output.output.vehicles[0].class, 'vehicle');
  const replay = await request('/api/ai/vehicle-detection', { method: 'POST', body: JSON.stringify({ ...payload, correlationId: 'replayed-ai-request-002' }) }, 'operator');
  assert.equal(replay.response.status, 202);
  assert.equal(replay.body.duplicate, true, 'replayed work is idempotent even with a new correlation ID');
  assert.equal(replay.body.finding.id, created.body.finding.id);
  const sightingAfter = await request('/api/sightings?caseId=case_KTM_0817', {}, 'reviewer');
  const placeAfter = await request('/api/place-leads?caseId=case_KTM_0817', {}, 'reviewer');
  assert.deepEqual(sightingAfter.body.sightings.map((item) => [item.id, item.status]), sightingBefore.body.sightings.map((item) => [item.id, item.status]), 'AI did not verify or alter sightings');
  assert.deepEqual(placeAfter.body.placeLeads.map((item) => [item.id, item.status]), placeBefore.body.placeLeads.map((item) => [item.id, item.status]), 'AI did not verify or alter locations');
  const audit = await request('/api/audit?caseId=case_KTM_0817', {}, 'reviewer');
  assert.ok(audit.body.records.some((record) => record.action === 'ai.analysis.completed'), 'completed AI work is audited');
  assert.ok(audit.body.records.some((record) => record.action === 'ai.model.finding.created'), 'finding creation is audited');
});

test('models must be evaluated and explicitly approved before they can produce pilot findings', async () => {
  const datasetId = 'dataset_vehicle_kathmandu_v1';
  const directApproval = await request('/api/models', { method: 'POST', body: JSON.stringify({ datasetId, name: 'Direct approval must fail', provider: 'mock', task: 'vehicle_detection', version: 'test-direct-1', status: 'approved_for_pilot', metrics: { precision: .99 }, approvalRef: 'TEST-DIRECT-APPROVAL' }) }, 'administrator');
  assert.equal(directApproval.response.status, 422);
  assert.equal(directApproval.body.error.code, 'model_must_begin_evaluation');
  const registered = await request('/api/models', { method: 'POST', body: JSON.stringify({ datasetId, name: 'Evaluation workflow test model', provider: 'mock', task: 'vehicle_detection', version: 'test-evaluation-1', metrics: { precision: .75 }, approvalRef: 'TEST-MODEL-REGISTRATION' }) }, 'administrator');
  assert.equal(registered.response.status, 201);
  assert.equal(registered.body.model.status, 'evaluation');
  const approvalExpiry = new Date(Date.now() + 3_600_000).toISOString();
  const noEvaluation = await request(`/api/models/${registered.body.model.id}/approve`, { method: 'POST', body: JSON.stringify({ approvalRef: 'TEST-PILOT-APPROVAL', approvalExpiresAt: approvalExpiry }) }, 'administrator');
  assert.equal(noEvaluation.response.status, 422);
  const evaluation = await request(`/api/models/${registered.body.model.id}/evaluations`, { method: 'POST', body: JSON.stringify({ metrics: { precision: .75, recall: .7 }, splitStrategy: 'Camera/session/time-separated split with a locked test set.', evaluationRef: 'TEST-EVALUATION-REPORT', status: 'accepted' }) }, 'supervisor');
  assert.equal(evaluation.response.status, 201);
  const approved = await request(`/api/models/${registered.body.model.id}/approve`, { method: 'POST', body: JSON.stringify({ approvalRef: 'TEST-PILOT-APPROVAL', approvalExpiresAt: approvalExpiry }) }, 'administrator');
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.model.status, 'approved_for_pilot');
});

test('training eligibility, grounded-output validation, disabled provider, malformed output, and timeout fail safely', async () => {
  const future = new Date(Date.now() + 86_400_000);
  const example = { sourceHash: 'example-source', storageReference: 'gs://civicwatch-test/authorized/example.jpg', checksum: 'example-checksum', sourceFilename: 'example.jpg', mimeType: 'image/jpeg', submitterAuthority: 'SUBMITTER', license: 'test license', provenance: 'controlled test provenance', authorizationRef: 'AUTH-1', annotationStatus: 'reviewer_verified', reviewedBy: 'reviewer.test', reviewedAt: new Date(), retentionUntil: future };
  const context = { dataset: { status: 'active', expiresAt: future }, caseRecord: { status: 'active', expiresAt: future } };
  assert.equal(isTrainingExampleEligible(example, context), true);
  assert.equal(isTrainingExampleEligible({ ...example, annotationStatus: 'pending_review', reviewedBy: null, reviewedAt: null }, context), false, 'unapproved training data is ineligible');
  assert.equal(isTrainingExampleEligible({ ...example, authorizationRef: '' }, context), false, 'missing authorization makes training data ineligible');
  assert.equal(isTrainingExampleEligible({ ...example, provenance: '' }, context), false, 'missing provenance makes training data ineligible');
  assert.equal(isTrainingExampleEligible({ ...example, retentionUntil: new Date(Date.now() - 1) }, context), false, 'expired retention makes training data ineligible');
  assert.throws(() => validateGroundedReasoning({ summary: 'Unsafe claim', recommendation: 'verified', supportingEvidence: [], conflictingEvidence: [], uncertainties: [], missingEvidence: [] }), (error) => error.code === 'prohibited_model_recommendation', 'prohibited LLM recommendation is rejected');

  const saved = { enabled: process.env.VERTEX_AI_ENABLED, authorized: process.env.AI_EXTERNAL_PROVIDER_AUTHORIZED, project: process.env.GOOGLE_CLOUD_PROJECT, timeout: process.env.VERTEX_AI_TIMEOUT_MS };
  try {
    process.env.VERTEX_AI_ENABLED = 'false';
    await assert.rejects(() => createVertexProvider().healthCheck(), (error) => error.code === 'provider_disabled', 'disabled provider is explicit');
    process.env.VERTEX_AI_ENABLED = 'true'; process.env.AI_EXTERNAL_PROVIDER_AUTHORIZED = 'true'; process.env.GOOGLE_CLOUD_PROJECT = 'test-project'; process.env.VERTEX_AI_TIMEOUT_MS = '10';
    const model = { id: 'model_reasoning_test', version: 'v1', endpointReference: 'test-endpoint' };
    const malformed = createVertexProvider({ clientFactory: () => ({ models: { generateContent: async () => ({ text: '{not-json' }) } }) });
    await assert.rejects(() => malformed.predict({ model, task: 'evidence_reasoning', caseContext: {}, evidence: {}, correlationId: 'malformed' }), (error) => error.code === 'invalid_provider_response', 'malformed provider output is rejected');
    const timeout = createVertexProvider({ clientFactory: () => ({ models: { generateContent: () => new Promise(() => {}) } }) });
    await assert.rejects(() => timeout.predict({ model, task: 'evidence_reasoning', caseContext: {}, evidence: {}, correlationId: 'timeout' }), (error) => error.code === 'provider_timeout', 'provider timeout is bounded');
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[{ enabled: 'VERTEX_AI_ENABLED', authorized: 'AI_EXTERNAL_PROVIDER_AUTHORIZED', project: 'GOOGLE_CLOUD_PROJECT', timeout: 'VERTEX_AI_TIMEOUT_MS' }[key]]; else process.env[{ enabled: 'VERTEX_AI_ENABLED', authorized: 'AI_EXTERNAL_PROVIDER_AUTHORIZED', project: 'GOOGLE_CLOUD_PROJECT', timeout: 'VERTEX_AI_TIMEOUT_MS' }[key]] = value; }
  }
});
