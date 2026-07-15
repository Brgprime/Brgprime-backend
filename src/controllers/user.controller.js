import bcrypt from 'bcryptjs';
import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { publicUser } from '../utils/serialize.js';
import { ok } from '../utils/respond.js';

// GET /api/users/me — profile with live listing/favourite counts.
export const getProfile = asyncHandler(async (req, res) => {
  const [listingCount, savedCount] = await Promise.all([
    prisma.property.count({ where: { ownerId: req.user.id } }),
    prisma.favorite.count({ where: { userId: req.user.id } }),
  ]);
  return ok(res, {
    user: publicUser(req.user),
    stats: { listingCount, savedCount },
  });
});

// PATCH /api/users/me — update profile fields.
export const updateProfile = asyncHandler(async (req, res) => {
  const b = req.body;
  const data = {};
  if (b.name) data.name = b.name;
  else if (b.firstName || b.lastName) {
    data.name = `${b.firstName || ''} ${b.lastName || ''}`.trim();
  }
  if (b.phone !== undefined) data.phone = b.phone;
  if (b.bio !== undefined) data.bio = b.bio;
  const avatar = b.profileImageUrl ?? b.avatarUrl;
  if (avatar !== undefined) data.avatarUrl = avatar;

  const user = await prisma.user.update({ where: { id: req.user.id }, data });
  return ok(res, { user: publicUser(user) }, { message: 'Profile updated successfully!' });
});

// POST /api/users/me/change-password
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const match = await bcrypt.compare(currentPassword, req.user.passwordHash);
  if (!match) throw ApiError.badRequest('Current password is incorrect.');

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash } });
  return ok(res, { updated: true }, { message: 'Password changed successfully.' });
});

// DELETE /api/users/me — delete own account.
export const deleteAccount = asyncHandler(async (req, res) => {
  await prisma.user.delete({ where: { id: req.user.id } });
  return ok(res, { deleted: true }, { message: 'Account deleted.' });
});
