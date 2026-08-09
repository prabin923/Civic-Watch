import { validateEvidenceSignals } from './validation/model-output.js';

export function fuseEvidence(input = {}) {
  const signals = validateEvidenceSignals(input.signals || []);
  const grouped = new Map();
  for (const signal of signals) grouped.set(signal.type, [...(grouped.get(signal.type) || []), signal]);
  const score = signals.reduce((sum, signal) => sum + signal.confidence, 0) / signals.length;
  const conflicts = [];
  for (const [type, items] of grouped) {
    if (items.length > 1 && Math.max(...items.map((item) => item.confidence)) - Math.min(...items.map((item) => item.confidence)) > .45) conflicts.push(`${type} signals disagree materially.`);
  }
  const uncertainties = [
    ...(input.uncertainties || []),
    ...(conflicts.length ? ['Conflicting evidence requires reviewer assessment.'] : []),
    'Evidence score prioritizes review; it does not verify a vehicle, sighting, or location.',
  ];
  return { signals, score: Number(score.toFixed(3)), uncertainties, conflicts, recommendation: 'review_required' };
}
