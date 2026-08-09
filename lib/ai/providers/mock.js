import { AiPolicyError } from '../types.js';

const now = () => new Date().toISOString();
const sourceName = (source) => source?.sourceHash?.slice(0, 12) || 'approved-source';

function base(model, source) {
  return { provider: 'mock', modelId: model.id, modelVersion: model.version, sourceHash: source.sourceHash, generatedAt: now() };
}

export function createMockProvider() {
  return {
    name: 'mock',
    async healthCheck() { return { healthy: true, provider: 'mock', externalCalls: false }; },
    async getModelMetadata(model) { return { provider: 'mock', modelId: model.id, version: model.version, task: model.task, deterministic: true }; },
    async train() { return { accepted: false, provider: 'mock', reason: 'Mock provider does not start training jobs.' }; },
    async evaluate({ model, metrics, splitStrategy }) { return { provider: 'mock', modelId: model.id, metrics, splitStrategy, status: 'recorded_only' }; },
    async predict({ model, task, source, evidence = {} }) {
      if (!source?.sourceHash) throw new AiPolicyError('A source hash is required for AI analysis.', 'missing_source_hash');
      const metadata = base(model, source);
      if (task === 'vehicle_detection') return { ...metadata, confidence: .91, recommendation: 'review_required', output: { vehicles: [{ bbox: { xMin: .12, yMin: .21, xMax: .79, yMax: .88 }, class: 'vehicle', confidence: .91 }] }, evidence: [{ type: 'vehicle_detection', confidence: .91, claim: `Mock detector found one vehicle candidate in ${sourceName(source)}.`, source: 'mock vehicle detector' }], uncertainties: ['Synthetic local estimate only; a reviewer must inspect approved source evidence.'] };
      if (task === 'vehicle_attributes') return {
        ...metadata, confidence: .87, recommendation: 'review_required',
        output: { attributes: {
          color: { value: 'white', confidence: .91, label: 'Model estimate' },
          bodyType: { value: 'hatchback', confidence: .84, label: 'Model estimate' },
          make: { value: 'Suzuki', confidence: .61, label: 'Model estimate' },
          model: { value: 'Swift', confidence: .54, label: 'Model estimate' },
        } },
        evidence: [{ type: 'vehicle_attributes', confidence: .87, claim: `Mock model estimate describes a possible white hatchback in ${sourceName(source)}.`, source: 'mock vehicle attribute model' }],
        uncertainties: ['Make and model are estimates, not confirmed vehicle attributes.'],
      };
      if (task === 'vehicle_reidentification') return { ...metadata, confidence: .87, recommendation: 'possible_match', output: { similarity: .87, comparison: 'candidate_similarity', identityScope: 'case_scoped_training_or_evaluation_only' }, evidence: [{ type: 'vehicle_similarity', confidence: .87, claim: `Mock embedding comparison returned a case-scoped similarity candidate for ${sourceName(source)}.`, source: 'mock re-identification model' }], uncertainties: ['Similarity does not establish that two images show the same vehicle.'] };
      if (task === 'plate_ocr') return { ...metadata, confidence: .73, recommendation: 'review_required', output: { rawText: 'BA 13 PA 4421', normalizedPlate: 'BA13PA4421', ocrConfidence: .73, engine: 'mock-tesseract-contract', languages: ['eng', 'nep'] }, evidence: [{ type: 'plate_ocr', confidence: .73, claim: `Mock OCR produced a possible plate read for ${sourceName(source)}.`, source: 'mock plate OCR' }], uncertainties: ['Plate text is an OCR estimate and requires source review.'] };
      if (task === 'place_geolocation') {
        const synthetic = String(source.sourceHash).includes('synthetic') || String(source.storageReference || '').includes('synthetic');
        return {
          ...metadata,
          confidence: synthetic ? .56 : .0,
          recommendation: synthetic ? 'possible_location_lead' : 'insufficient_evidence',
          output: { locationCandidate: synthetic ? { resolution: 'landmark_area', latitude: 27.7049, longitude: 85.3075, radiusMeters: 450, confidence: .56, evidence: ['demo-only landmark signal'], status: 'pending_review' } : null },
          evidence: synthetic ? [{ type: 'location_candidate', confidence: .56, claim: 'Mock local landmark candidate is limited to the synthetic Kathmandu scenario.', source: 'mock place provider' }] : [{ type: 'location_candidate', confidence: 0, claim: 'No reliable location evidence was available.', source: 'mock place provider' }],
          uncertainties: synthetic ? ['Demo-only location lead; it is not an exact or current location.'] : ['Insufficient evidence. No location candidate was created.'],
        };
      }
      if (task === 'evidence_reasoning') return { ...metadata, confidence: .62, recommendation: 'review_required', output: { summary: 'Mock grounded reasoning summarized only the supplied structured evidence.', supportingEvidence: Object.keys(evidence).slice(0, 4), conflictingEvidence: [], uncertainties: ['Mock provider output is deterministic and not an operational conclusion.'], missingEvidence: ['Independent reviewer assessment'], recommendation: 'review_required' }, evidence: [{ type: 'evidence_fusion', confidence: .62, claim: 'Mock structured evidence review requires a human reviewer.', source: 'mock grounded reasoning' }], uncertainties: ['The reasoning output cannot verify a sighting or location.'] };
      throw new AiPolicyError('The mock provider does not support this analysis task.', 'unsupported_model_task');
    },
  };
}
