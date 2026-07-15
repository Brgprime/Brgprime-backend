// Transform DB rows into the JSON shapes the frontend expects.
import { subscriptionSnapshot } from '../config/plans.js';

const parseJson = (v, fallback) => {
  if (Array.isArray(v)) return v;
  try {
    return JSON.parse(v ?? '');
  } catch {
    return fallback;
  }
};

// Public user shape (never leak passwordHash / otp).
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    bio: u.bio,
    profileImageUrl: u.avatarUrl,
    avatarUrl: u.avatarUrl,
    role: u.role,
    status: u.status,
    emailVerified: u.emailVerified,
    joinDate: u.joinDate,
    createdAt: u.createdAt,
    subscription: subscriptionSnapshot(u),
  };
}

// Property shape matches the frontend property object (arrays decoded, ids as strings).
export function publicProperty(p, { savedIds } = {}) {
  if (!p) return null;
  return {
    id: p.id,
    title: p.title,
    address: p.address,
    description: p.description,
    price: p.price,
    listingType: p.listingType,
    propertyType: p.propertyType,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    size: p.size,
    yearBuilt: p.yearBuilt,
    furnishingStatus: p.furnishingStatus,
    propertyCondition: p.propertyCondition,
    amenities: parseJson(p.amenities, []),
    images: parseJson(p.images, []),
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : p.createdAt?.toISOString?.().slice(0, 10),
    isRecentlyPosted: p.isRecentlyPosted,
    isVerified: p.isVerified,
    isPremium: p.isPremium,
    isBoosted: p.isBoosted,
    agentName: p.agentName,
    agentAvatar: p.agentAvatar,
    rating: p.rating,
    reviewCount: p.reviewCount,
    status: p.status,
    adminStatus: p.adminStatus,
    views: p.views,
    saves: p.saves,
    ownerId: p.ownerId,
    isSaved: savedIds ? savedIds.has(p.id) : undefined,
  };
}

export function publicNotification(n) {
  return {
    id: n.id,
    title: n.title,
    message: n.message,
    type: n.type,
    read: n.read,
    time: n.createdAt,
    createdAt: n.createdAt,
  };
}

export function publicForumMessage(m, currentUserId) {
  return {
    id: m.id,
    sender: m.sender,
    text: m.text,
    avatar: m.avatar,
    isMe: !!currentUserId && m.userId === currentUserId,
    time: m.createdAt,
    createdAt: m.createdAt,
  };
}

export function publicPayment(p) {
  return {
    id: p.id,
    tenantName: p.tenantName,
    property: p.property,
    amount: p.amount,
    status: p.status,
    date: p.date,
  };
}

export function publicViewing(v) {
  return {
    id: v.id,
    propertyId: v.propertyId,
    fullName: v.fullName,
    phone: v.phone,
    email: v.email,
    date: v.date,
    time: v.time,
    message: v.message,
    status: v.status,
    createdAt: v.createdAt,
  };
}
