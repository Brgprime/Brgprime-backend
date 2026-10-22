// Subscription plan catalogue — the single source of truth for monetization.
// Mirrors the frontend `subscription` store (PLANS) exactly so web + mobile
// and the backend agree on limits and pricing.
// Ordered by ascending monthly price (Bronze is intentionally above Silver).

export const PLANS = [
  {
    id: 'free',
    name: 'Free Plan',
    price: 0,
    listings: 3,
    premium: 0,
    boosts: 0,
    leads: false,
    tagline: 'Get started — list up to 3 properties',
    features: [
      'Up to 3 property listings',
      'Standard search placement',
      'In-app messaging',
      'Basic property search',
    ],
  },
  {
    id: 'silver',
    name: 'Silver Plan',
    price: 18000,
    listings: 55,
    premium: 10,
    boosts: 5,
    leads: true,
    popular: true,
    tagline: 'For active landlords and agents',
    features: [
      'Up to 55 listings',
      '10 premium listings',
      '5 listing boosts',
      'Unlimited property requests (leads)',
      'Priority support',
    ],
  },
  {
    id: 'bronze',
    name: 'Bronze Plan',
    price: 40000,
    listings: 260,
    premium: 50,
    boosts: 30,
    leads: true,
    tagline: 'For growing real estate businesses',
    features: [
      'Up to 260 listings',
      '50 premium listings',
      '30 listing boosts',
      'Unlimited property requests (leads)',
      'Priority support',
    ],
  },
  {
    id: 'gold',
    name: 'Gold Plan',
    price: 64000,
    listings: 520,
    premium: 100,
    boosts: 55,
    leads: true,
    tagline: 'For agencies operating at scale',
    features: [
      'Up to 520 listings',
      '100 premium listings',
      '55 listing boosts',
      'Unlimited property requests (leads)',
      'Dedicated account manager',
    ],
  },
];

export const getPlan = (id) => PLANS.find((p) => p.id === id) || PLANS[0];

// Derived subscription snapshot for a user record (limits + remaining).
export function subscriptionSnapshot(user) {
  const plan = getPlan(user.planId);
  const premiumUsed = user.premiumUsed ?? 0;
  const boostsUsed = user.boostsUsed ?? 0;
  // Admins have no listing, premium or boost caps, whatever plan they're on.
  // Their limits and remaining counts are null (JSON has no Infinity).
  const unlimited = user.role === 'admin';
  return {
    planId: plan.id,
    plan,
    unlimited,
    listingLimit: unlimited ? null : plan.listings,
    premiumLimit: unlimited ? null : plan.premium,
    boostLimit: unlimited ? null : plan.boosts,
    hasLeads: plan.leads,
    isPaid: plan.id !== 'free',
    premiumUsed,
    boostsUsed,
    premiumRemaining: unlimited ? null : Math.max(0, plan.premium - premiumUsed),
    boostsRemaining: unlimited ? null : Math.max(0, plan.boosts - boostsUsed),
    renewsAt: user.renewsAt ?? null,
  };
}
