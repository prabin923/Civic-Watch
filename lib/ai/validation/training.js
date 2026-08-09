const validStorageReference = (value) => {
  const reference = String(value || '');
  if (!/^gs:\/\/[a-z0-9][a-z0-9._-]{1,220}\/.+/i.test(reference)) return false;
  const bucket = String(process.env.GOOGLE_CLOUD_STORAGE_BUCKET || '').replace(/^gs:\/\//, '').replace(/\/$/, '');
  return !bucket || reference.startsWith(`gs://${bucket}/`);
};
const present = (value) => typeof value === 'string' ? value.trim().length > 0 : Boolean(value);

export function trainingExampleEligibility(example, { dataset, caseRecord, at = new Date() } = {}) {
  const reasons = [];
  if (!example || !dataset || !caseRecord) reasons.push('missing_context');
  if (!present(example?.authorizationRef) || !present(example?.submitterAuthority)) reasons.push('missing_authorization');
  if (!present(example?.provenance)) reasons.push('missing_provenance');
  if (!present(example?.license)) reasons.push('missing_license');
  if (!present(example?.checksum) || !present(example?.sourceHash)) reasons.push('missing_integrity_hash');
  if (!present(example?.sourceFilename)) reasons.push('missing_source_filename');
  if (!present(example?.mimeType)) reasons.push('missing_mime_type');
  if (!validStorageReference(example?.storageReference)) reasons.push('invalid_storage_reference');
  if (example?.annotationStatus !== 'reviewer_verified' || !example?.reviewedBy || !example?.reviewedAt) reasons.push('reviewer_approval_required');
  if (dataset?.status !== 'active' && dataset?.status !== 'ready_for_review') reasons.push('dataset_inactive');
  if (!dataset?.expiresAt || new Date(dataset.expiresAt) <= at) reasons.push('dataset_expired');
  if (caseRecord?.status !== 'active' || new Date(caseRecord?.expiresAt || 0) <= at) reasons.push('case_expired');
  if (!example?.retentionUntil || new Date(example.retentionUntil) <= at) reasons.push('retention_expired');
  return { eligible: reasons.length === 0, reasons };
}

export function isTrainingExampleEligible(example, context) {
  return trainingExampleEligibility(example, context).eligible;
}

export { validStorageReference };
