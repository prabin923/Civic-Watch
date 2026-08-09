export const estimateVehicleAttributes = (provider, input) => provider.predict({ ...input, task: 'vehicle_attributes' });
