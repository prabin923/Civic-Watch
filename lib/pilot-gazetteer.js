const pilotPlaces = [
  { name: 'Kathmandu Durbar Square', address: 'Kathmandu Durbar Square, Kathmandu 44600, Nepal', latitude: 27.7049, longitude: 85.3075, aliases: ['kathmandu durbar square', 'basantapur durbar square', 'basantapur'] },
  { name: 'Thamel', address: 'Thamel, Kathmandu 44600, Nepal', latitude: 27.7155, longitude: 85.3123, aliases: ['thamel', 'thamel chowk', 'thame'] },
  { name: 'Boudhanath Stupa', address: 'Boudhanath Stupa, Kathmandu 44600, Nepal', latitude: 27.7215, longitude: 85.3620, aliases: ['boudhanath', 'boudha stupa', 'bouddhanath'] },
  { name: 'Swayambhunath Stupa', address: 'Swayambhunath Stupa, Kathmandu 44600, Nepal', latitude: 27.7149, longitude: 85.2903, aliases: ['swayambhunath', 'swayambhu', 'monkey temple'] },
  { name: 'Tribhuvan International Airport', address: 'Tribhuvan International Airport, Kathmandu 44600, Nepal', latitude: 27.6966, longitude: 85.3591, aliases: ['tribhuvan international airport', 'tia airport', 'kathmandu airport'] },
  { name: 'Patan Durbar Square', address: 'Patan Durbar Square, Lalitpur 44700, Nepal', latitude: 27.6722, longitude: 85.3256, aliases: ['patan durbar square', 'lalitpur durbar square'] },
  { name: 'Bhaktapur Durbar Square', address: 'Bhaktapur Durbar Square, Bhaktapur 44800, Nepal', latitude: 27.671, longitude: 85.4298, aliases: ['bhaktapur durbar square', 'bhaktapur durbar'] },
  { name: 'Singha Durbar', address: 'Singha Durbar, Kathmandu 44600, Nepal', latitude: 27.7004, longitude: 85.3215, aliases: ['singha durbar', 'singh durbar'] },
];

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

export function matchPilotGazetteer(value) {
  const query = normalize(value);
  if (!query) return null;
  const match = pilotPlaces.map((place) => {
    const alias = place.aliases.find((candidate) => query.includes(candidate));
    return alias ? { place, alias } : null;
  }).find(Boolean);
  if (!match) return null;
  return { ...match.place, matchedAlias: match.alias };
}

export { pilotPlaces };
