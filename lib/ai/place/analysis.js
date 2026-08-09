export function toLocationCandidate(detected, sourceHash) {
  if (!detected || detected.sourceKind === 'no_location_signal' || detected.latitude == null || detected.longitude == null) return { locationCandidate: null, provider: detected?.provider || 'local-place-analysis', sourceHash, uncertainties: ['Insufficient evidence. No location candidate was created.'] };
  const resolution = detected.sourceKind === 'embedded_gps' ? 'exact_coordinate' : detected.sourceKind === 'pilot_ocr_gazetteer' ? 'landmark_area' : 'approximate_point';
  return {
    locationCandidate: { resolution, latitude: detected.latitude, longitude: detected.longitude, radiusMeters: resolution === 'exact_coordinate' ? 30 : 500, confidence: detected.confidence || 0, evidence: [detected.label || detected.sourceKind], status: 'pending_review' },
    provider: detected.provider,
    sourceHash,
    uncertainties: ['Location evidence is a confidence-based lead, not an exact or current location.'],
  };
}
