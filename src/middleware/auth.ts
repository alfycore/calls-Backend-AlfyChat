// ==========================================
// ALFYCHAT - MIDDLEWARE D'AUTHENTIFICATION (CALLS SERVICE)
// ==========================================

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');

const INTERNAL_SECRET = process.env.INTERNAL_SECRET;
if (!INTERNAL_SECRET) throw new Error('INTERNAL_SECRET environment variable is required — refusing to start without it');

function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface AuthRequest extends Request {
  userId?: string;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  // Bypass interne : requêtes provenant du gateway avec x-internal-secret
  const internalSecret = req.headers['x-internal-secret'] as string | undefined;
  if (internalSecret && safeCompare(internalSecret, INTERNAL_SECRET)) {
    const xUserId = req.headers['x-user-id'] as string | undefined;
    if (xUserId) {
      req.userId = xUserId;
      return next();
    }
  }

  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ error: 'Token d\'authentification requis' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET as string) as unknown as { userId: string };
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}
