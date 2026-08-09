export const detectVehicles = (provider, input) => provider.predict({ ...input, task: 'vehicle_detection' });
