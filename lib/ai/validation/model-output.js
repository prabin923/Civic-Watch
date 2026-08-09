import { AiPolicyError, EVIDENCE_SIGNAL_TYPES, FINDING_RECOMMENDATIONS } from '../types.js';

const isFiniteConfidence = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1;
const boundedStrings = (value, field) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 600)) throw new AiPolicyError(`${field} must be a list of concise text values.`, 'invalid_model_output');
  return value.map((item) => item.trim());
};

export function validateEvidenceSignals(signals) {
  if (!Array.isArray(signals) || signals.length < 1 || signals.length > 12) throw new AiPolicyError('AI analysis requires one to twelve structured evidence signals.', 'invalid_model_output');
  return signals.map((signal) => {
    if (!signal || !EVIDENCE_SIGNAL_TYPES.includes(signal.type) || !isFiniteConfidence(signal.confidence) || typeof signal.claim !== 'string' || !signal.claim.trim() || signal.claim.length > 600 || typeof signal.source !== 'string' || !signal.source.trim() || signal.source.length > 320) throw new AiPolicyError('AI evidence must be grounded, typed, and confidence-bounded.', 'invalid_model_output');
    return { type: signal.type, confidence: Number(signal.confidence), claim: signal.claim.trim(), source: signal.source.trim() };
  });
}

export function validateGroundedReasoning(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new AiPolicyError('The reasoning provider did not return a structured object.', 'invalid_model_output');
  if (typeof output.summary !== 'string' || !output.summary.trim() || output.summary.length > 1600) throw new AiPolicyError('The reasoning summary is missing or too long.', 'invalid_model_output');
  if (!FINDING_RECOMMENDATIONS.includes(output.recommendation)) throw new AiPolicyError('The reasoning provider returned a prohibited recommendation.', 'prohibited_model_recommendation');
  return {
    summary: output.summary.trim(),
    supportingEvidence: boundedStrings(output.supportingEvidence || [], 'Supporting evidence'),
    conflictingEvidence: boundedStrings(output.conflictingEvidence || [], 'Conflicting evidence'),
    uncertainties: boundedStrings(output.uncertainties || [], 'Uncertainties'),
    missingEvidence: boundedStrings(output.missingEvidence || [], 'Missing evidence'),
    recommendation: output.recommendation,
  };
}
