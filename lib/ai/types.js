export const MODEL_TASKS = Object.freeze([
  'vehicle_detection',
  'vehicle_attributes',
  'vehicle_reidentification',
  'plate_ocr',
  'place_geolocation',
  'evidence_reasoning',
]);

export const MODEL_PROVIDERS = Object.freeze(['mock', 'vertex_ai', 'google_cloud_vision', 'custom_edge', 'grounded_llm', 'evidence_fusion']);
export const MODEL_STATUSES = Object.freeze(['evaluation', 'approved_for_pilot', 'retired']);
export const FINDING_RECOMMENDATIONS = Object.freeze(['review_required', 'insufficient_evidence', 'possible_match', 'possible_location_lead']);
export const EVIDENCE_SIGNAL_TYPES = Object.freeze(['vehicle_detection', 'vehicle_attributes', 'vehicle_similarity', 'plate_ocr', 'signage_ocr', 'landmark', 'embedded_gps', 'camera_context', 'map_context', 'location_candidate', 'evidence_fusion']);

export class AiPolicyError extends Error {
  constructor(message, code = 'ai_request_rejected', status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const aiDeny = (message, code, status) => { throw new AiPolicyError(message, code, status); };
