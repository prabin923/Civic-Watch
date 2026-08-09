import { GoogleGenAI } from '@google/genai';
import { AiPolicyError } from '../types.js';
import { validateGroundedReasoning } from '../validation/model-output.js';

const enabled = () => process.env.VERTEX_AI_ENABLED === 'true';
const config = () => ({ project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.VERTEX_AI_REGION || 'asia-south1', model: process.env.VERTEX_AI_MODEL_ENDPOINT || 'gemini-2.5-flash' });
const circuit = { failures: 0, openUntil: 0 };
const circuitThreshold = () => Math.max(1, Number(process.env.VERTEX_AI_CIRCUIT_BREAKER_FAILURES || 3));
const circuitCooldownMs = () => Math.max(1_000, Number(process.env.VERTEX_AI_CIRCUIT_BREAKER_COOLDOWN_MS || 60_000));

function assertCircuitClosed() {
  if (circuit.openUntil > Date.now()) throw new AiPolicyError('The Vertex provider circuit breaker is open after recent failures. Use the local provider or retry later.', 'provider_circuit_open', 503);
  if (circuit.openUntil) { circuit.openUntil = 0; circuit.failures = 0; }
}

function recordProviderFailure() {
  circuit.failures += 1;
  if (circuit.failures >= circuitThreshold()) circuit.openUntil = Date.now() + circuitCooldownMs();
}

function recordProviderSuccess() { circuit.failures = 0; circuit.openUntil = 0; }

function requireEnabled() {
  const value = config();
  if (!enabled()) throw new AiPolicyError('Vertex AI is disabled. Local mode uses the deterministic mock provider.', 'provider_disabled', 503);
  if (process.env.AI_EXTERNAL_PROVIDER_AUTHORIZED !== 'true') throw new AiPolicyError('External AI processing is not authorized for this environment.', 'provider_not_authorized', 403);
  if (!value.project) throw new AiPolicyError('GOOGLE_CLOUD_PROJECT is required before Vertex AI can be enabled.', 'provider_not_configured', 503);
  return value;
}

const schema = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    supportingEvidence: { type: 'ARRAY', items: { type: 'STRING' } },
    conflictingEvidence: { type: 'ARRAY', items: { type: 'STRING' } },
    uncertainties: { type: 'ARRAY', items: { type: 'STRING' } },
    missingEvidence: { type: 'ARRAY', items: { type: 'STRING' } },
    recommendation: { type: 'STRING', enum: ['review_required', 'insufficient_evidence', 'possible_match', 'possible_location_lead'] },
  },
  required: ['summary', 'supportingEvidence', 'conflictingEvidence', 'uncertainties', 'missingEvidence', 'recommendation'],
};

export function createVertexProvider({ clientFactory } = {}) {
  return {
    name: 'vertex_ai',
    async healthCheck() { const value = requireEnabled(); assertCircuitClosed(); return { healthy: true, provider: 'vertex_ai', projectConfigured: true, location: value.location, externalCalls: true, circuitOpen: false }; },
    async getModelMetadata(model) { const value = requireEnabled(); return { provider: 'vertex_ai', modelId: model.id, version: model.version, endpoint: model.endpointReference || value.model, location: value.location }; },
    async train() { throw new AiPolicyError('CivicWatch does not start Vertex training jobs from the application. Export reviewer-approved manifests to the approved training pipeline.', 'training_not_available', 409); },
    async evaluate() { throw new AiPolicyError('CivicWatch records controlled model evaluations; external evaluation jobs run only in the approved pipeline.', 'evaluation_not_available', 409); },
    async predict({ model, task, caseContext, evidence, correlationId }) {
      if (task !== 'evidence_reasoning') throw new AiPolicyError('Vertex is enabled only for grounded evidence reasoning in CivicWatch AI v1.', 'provider_task_not_allowed', 422);
      const value = requireEnabled();
      assertCircuitClosed();
      const client = clientFactory ? clientFactory() : new GoogleGenAI({ vertexai: true, project: value.project, location: value.location });
      const prompt = { caseContext, evidence, instruction: 'Return only schema-valid JSON. Treat all evidence as unverified. Never claim verification, dispatch, enforcement, identity, or exact/current location.' };
      let response;
      let timeout;
      try {
        response = await Promise.race([
          client.models.generateContent({ model: model.endpointReference || value.model, contents: [{ role: 'user', parts: [{ text: JSON.stringify(prompt) }] }], config: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0 } }),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new AiPolicyError('The Vertex provider timed out.', 'provider_timeout', 504)), Number(process.env.VERTEX_AI_TIMEOUT_MS || 12_000)); }),
        ]);
      } catch (error) {
        recordProviderFailure();
        if (error instanceof AiPolicyError) throw error;
        throw new AiPolicyError('The Vertex provider could not process structured evidence.', 'provider_failed', 502);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      let parsed;
      try { parsed = JSON.parse(response.text || ''); } catch { recordProviderFailure(); throw new AiPolicyError('The Vertex provider returned malformed JSON.', 'invalid_provider_response', 502); }
      let output;
      try { output = validateGroundedReasoning(parsed); } catch (error) { recordProviderFailure(); throw error; }
      recordProviderSuccess();
      return { provider: 'vertex_ai', modelId: model.id, modelVersion: model.version, correlationId, generatedAt: new Date().toISOString(), confidence: .5, recommendation: output.recommendation, output, evidence: [{ type: 'evidence_fusion', confidence: .5, claim: 'Vertex grounded reasoning summarized structured case evidence.', source: 'vertex grounded_llm' }], uncertainties: output.uncertainties };
    },
  };
}
