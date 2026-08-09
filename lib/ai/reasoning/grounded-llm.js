export const reasonOverStructuredEvidence = (provider, input) => provider.predict({ ...input, task: 'evidence_reasoning' });
