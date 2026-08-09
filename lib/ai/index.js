import { fuseEvidence } from './evidence-fusion.js';
import { AiPolicyError, MODEL_TASKS } from './types.js';
import { createMockProvider } from './providers/mock.js';
import { createVertexProvider } from './providers/vertex.js';
import { detectVehicles } from './vehicle/detection.js';
import { estimateVehicleAttributes } from './vehicle/attributes.js';
import { compareVehicleSimilarity } from './vehicle/reidentification.js';
import { reasonOverStructuredEvidence } from './reasoning/grounded-llm.js';

export { AiPolicyError, FINDING_RECOMMENDATIONS, MODEL_PROVIDERS, MODEL_STATUSES, MODEL_TASKS } from './types.js';
export { isTrainingExampleEligible, trainingExampleEligibility, validStorageReference } from './validation/training.js';
export { validateEvidenceSignals, validateGroundedReasoning } from './validation/model-output.js';
export { isModelEligible, modelEligibility } from './model-registry.js';
export { fuseEvidence } from './evidence-fusion.js';
export { normalizePlate, readPlateLocally } from './ocr/plate.js';
export { toLocationCandidate } from './place/analysis.js';

export function providerFor(model) {
  if (process.env.VERTEX_AI_ENABLED === 'true' && ['vertex_ai', 'grounded_llm'].includes(model.provider)) return createVertexProvider();
  return createMockProvider();
}

export async function runAiTask({ model, task, source, caseContext, structuredEvidence = {}, correlationId }) {
  if (!MODEL_TASKS.includes(task)) throw new AiPolicyError('The requested AI task is not supported.', 'unsupported_model_task');
  const provider = providerFor(model);
  const input = { model, source, caseContext, evidence: structuredEvidence, correlationId };
  if (task === 'vehicle_detection') return detectVehicles(provider, input);
  if (task === 'vehicle_attributes') return estimateVehicleAttributes(provider, input);
  if (task === 'vehicle_reidentification') return compareVehicleSimilarity(provider, input);
  if (task === 'evidence_reasoning') return reasonOverStructuredEvidence(provider, input);
  if (task === 'plate_ocr' || task === 'place_geolocation') return provider.predict({ ...input, task });
  throw new AiPolicyError('No provider was selected for the requested task.', 'provider_not_available', 503);
}

export function runEvidenceFusion({ signals, uncertainties }) {
  return fuseEvidence({ signals, uncertainties });
}
