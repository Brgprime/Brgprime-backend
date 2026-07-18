import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export function signToken(payload) {
  return jwt.sign({ ...payload, type: 'access' }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

// Long-lived token used only to mint fresh access tokens.
export function signRefreshToken(payload) {
  return jwt.sign({ ...payload, type: 'refresh' }, env.jwtSecret, {
    expiresIn: env.jwtRefreshExpiresIn,
  });
}

export function verifyToken(token) {
  return jwt.verify(token, env.jwtSecret);
}
