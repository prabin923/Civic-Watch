import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { prisma } from '../lib/prisma.js';
import { createApp, resetAndSeed } from '../lib/platform.js';
import { matchPilotGazetteer } from '../lib/pilot-gazetteer.js';

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
test('auth sessions protect the console and can be revoked', async () => { const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@civicwatch.local', password: 'CivicWatchDemo!2026' }) }); assert.equal(login.response.status, 200); const cookie = login.response.headers.get('set-cookie'); assert.ok(cookie?.includes('civicwatch_session=')); const me = await request('/api/auth/me', { headers: { cookie } }, 'operator'); assert.equal(me.body.user.email, 'admin@civicwatch.local'); assert.equal(me.body.user.role, 'administrator'); const protectedConfig = await request('/api/config', { headers: { cookie } }, 'reviewer'); assert.equal(protectedConfig.response.status, 200); const logout = await request('/api/auth/logout', { method: 'POST', headers: { cookie } }, 'operator'); assert.equal(logout.body.signedOut, true); const afterLogout = await request('/api/auth/me', { headers: { cookie } }, 'operator'); assert.equal(afterLogout.response.status, 401); });
test('synthetic demo reset is administrator-only and restores a presentable route scenario', async () => { const denied = await request('/api/demo/reset', { method: 'POST', body: '{}' }, 'operator'); assert.equal(denied.response.status, 403); const restored = await request('/api/demo/reset', { method: 'POST', body: '{}' }, 'administrator'); assert.equal(restored.body.scenario, 'synthetic-kathmandu-vehicle-route'); const map = await request('/api/map-layer?caseId=case_KTM_0817&include=all', {}, 'reviewer'); assert.equal(map.body.sightings.length, 3); assert.equal(map.body.sightings.filter((item) => item.status === 'verified').length, 2); assert.equal(map.body.sightings.filter((item) => item.status === 'pending_review').length, 1); });
test('image place leads are case-scoped, synthetic-demo capable, and reviewer-gated', async () => { const denied = await request('/api/place-leads', { method: 'POST', body: JSON.stringify({ caseId: 'case_KTM_0817', demo: true }) }, 'reviewer'); assert.equal(denied.response.status, 403); const created = await request('/api/place-leads', { method: 'POST', body: JSON.stringify({ caseId: 'case_KTM_0817', demo: true }) }, 'operator'); assert.equal(created.response.status, 202); assert.equal(created.body.disposition, 'pending_human_review'); assert.equal(created.body.placeLead.sourceKind, 'synthetic_demo'); assert.equal(created.body.placeLead.address, 'Kathmandu Durbar Square, Kathmandu 44600, Nepal'); assert.equal(created.body.placeLead.status, 'pending_review'); const list = await request('/api/place-leads?caseId=case_KTM_0817', {}, 'reviewer'); const lead = list.body.placeLeads.find((item) => item.id === created.body.placeLead.id); assert.ok(lead); assert.equal(lead.label, lead.address); const approved = await request(`/api/place-leads/${lead.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'approve', reason: 'Synthetic scenario reviewed against its documented demo context.' }) }, 'reviewer'); assert.equal(approved.response.status, 200); assert.equal(approved.body.placeLead.status, 'verified'); assert.equal(JSON.stringify(approved.body).includes('imageBase64'), false); });
test('an authorized image with no supported location signal remains only an audited no-result', async () => { const configuredKey = process.env.GOOGLE_VISION_API_KEY; delete process.env.GOOGLE_VISION_API_KEY; let response; try { response = await request('/api/place-leads', { method: 'POST', body: JSON.stringify({ caseId: 'case_KTM_0817', imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg', filename: 'no-location.jpg', submitterAuthority: 'Test evidence receipt' }) }, 'operator'); } finally { if (configuredKey) process.env.GOOGLE_VISION_API_KEY = configuredKey; } assert.equal(response.response.status, 202); assert.equal(response.body.disposition, 'no_location_signal'); const list = await request('/api/place-leads?caseId=case_KTM_0817', {}, 'reviewer'); assert.equal(list.body.placeLeads.some((item) => item.sourceFilename === 'no-location.jpg'), false); });
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
  const submitted = await request(`/api/training/datasets/${placeDataset.id}/examples`, { method: 'POST', body: JSON.stringify({ sourceHash: 'test-training-place-hash', storageReference: 'gs://civicwatch-test/authorized/place-002.jpg', checksum: 'test-training-place-checksum', sourceFilename: 'place-002.jpg', mimeType: 'image/jpeg', submitterAuthority: 'TEST-AUTHORIZED-SUBMITTER', annotation: { latitude: 27.7172, longitude: 85.324, landmark: 'Synthetic test label' } }) }, 'operator');
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
