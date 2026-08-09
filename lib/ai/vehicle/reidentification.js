export const compareVehicleSimilarity = (provider, input) => provider.predict({ ...input, task: 'vehicle_reidentification' });
