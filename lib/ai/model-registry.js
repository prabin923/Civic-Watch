export function modelEligibility(model, at = new Date()) {
  const reasons = [];
  if (!model) reasons.push('model_not_found');
  if (model?.status !== 'approved_for_pilot') reasons.push('model_not_approved');
  if (!model?.approvedAt || !model?.approvedBy || !model?.approvalRef) reasons.push('approval_incomplete');
  if (!model?.approvalExpiresAt || new Date(model.approvalExpiresAt) <= at) reasons.push('approval_expired');
  if (!model?.version) reasons.push('model_version_missing');
  return { eligible: reasons.length === 0, reasons };
}

export const isModelEligible = (model, at) => modelEligibility(model, at).eligible;
