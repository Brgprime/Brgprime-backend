// Locations across Nigeria used by the search/filter dropdown.
// Major cities first, then popular areas (matched against listing addresses).
export const nigerianLocations = [
  'Lagos', 'Abuja', 'Port Harcourt', 'Ibadan', 'Enugu', 'Benin City',
  'Kano', 'Kaduna', 'Asaba', 'Owerri', 'Uyo', 'Calabar', 'Jos', 'Abeokuta', 'Warri',
  'Lekki', 'Victoria Island', 'Ikoyi', 'Yaba', 'Ajah',
  'Maitama', 'Wuse', 'Gwarinpa', 'Asokoro', 'GRA',
]

// Backwards-compatible alias (kept for any older imports).
export const lagosLocations = nigerianLocations

export const majorCities = [
  'Lagos', 'Abuja', 'Port Harcourt', 'Ibadan', 'Kano',
  'Kaduna', 'Benin City', 'Enugu', 'Calabar', 'Uyo', 'Warri', 'Owerri',
]

// Popular cities for the dashboard carousel — nationwide coverage.
const popularCities = [
  { name: 'Lagos',         count: 1240 },
  { name: 'Abuja',         count: 860 },
  { name: 'Port Harcourt', count: 412 },
  { name: 'Ibadan',        count: 318 },
  { name: 'Enugu',         count: 244 },
  { name: 'Benin City',    count: 196 },
  { name: 'Kano',          count: 173 },
  { name: 'Kaduna',        count: 151 },
]

export const popularLocations = popularCities.map((c) => ({
  name:  c.name,
  image: `https://picsum.photos/seed/${encodeURIComponent(c.name)}/300/200`,
  count: c.count,
}))
