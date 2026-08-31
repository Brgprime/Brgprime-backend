// Nigerian locations used by search/filter dropdowns and dashboard carousel.
// Mirrors the frontend nigerianLocations.js exactly.
export const nigerianLocations = [
  'Lagos', 'Abuja', 'Port Harcourt', 'Ibadan', 'Enugu', 'Benin City',
  'Kano', 'Kaduna', 'Asaba', 'Owerri', 'Uyo', 'Calabar', 'Jos', 'Abeokuta', 'Warri',
  'Lekki', 'Victoria Island', 'Ikoyi', 'Yaba', 'Ajah',
  'Maitama', 'Wuse', 'Gwarinpa', 'Asokoro', 'GRA',
];

export const majorCities = [
  'Lagos', 'Abuja', 'Port Harcourt', 'Ibadan', 'Kano',
  'Kaduna', 'Benin City', 'Enugu', 'Calabar', 'Uyo', 'Warri', 'Owerri',
];

// The popular-location carousel used to read a hardcoded count per city
// (Lagos 1240, Abuja 860, …). Those were invented figures, and unused since
// meta.controller computes the real ones from active listings — see
// computePopularLocations(). Nothing here fabricates a number any more.
