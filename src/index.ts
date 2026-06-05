// ==========================================
// ALFYCHAT - SERVICE APPELS
// Gestion des appels DM / groupe / serveur (WebRTC)
// ==========================================

import dotenv from 'dotenv';
import path from 'path';
dotenv.config();
import { registerGlobalErrorHandlers } from './utils/error-reporter';
registerGlobalErrorHandlers();
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';
import mysql, { Pool, RowDataPacket } from 'mysql2/promise';
import Redis from 'ioredis';
import winston from 'winston';
import { startServiceRegistration, serviceMetricsMiddleware, collectServiceMetrics } from './utils/service-client';
import { authMiddleware, AuthRequest } from './middleware/auth';
import type { CallCategory, QualityTier } from './types/call';

const _allowedOrigins = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:4000')
  .split(',').map((o) => o.trim());

const app = express();
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
    if (_allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origine non autorisée — ${origin}`));
  },
  credentials: true,
}));
app.use(helmet());
app.use(express.json());
app.use(serviceMetricsMiddleware);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.simple()),
  transports: [new winston.transports.Console()],
});

let pool: Pool;
let redis: Redis;

export function getDatabase() { return pool; }
export function getRedis() { return redis; }

// Middleware pour les appels internes (media-server → calls)
function internalAuth(req: Request, res: Response, next: NextFunction) {
  const secret = req.headers['x-internal-secret'];
  if (!secret || secret !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Accès interne requis' });
  }
  next();
}

// ============ LIMITES PARTICIPANTS ============

const DEFAULT_LIMITS: Record<CallCategory, number> = { dm: 2, group: 100, server: 1500 };

async function getParticipantLimit(category: CallCategory, serverId?: string): Promise<number> {
  const scopeId = category === 'server' && serverId ? serverId : 'global';
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT max_participants FROM call_participant_limits WHERE scope_type = ? AND scope_id = ?',
    [category, scopeId]
  );
  if (rows.length > 0) return rows[0].max_participants as number;
  // Fallback sur la limite globale pour les serveurs qui n'en ont pas de personnalisée
  if (category === 'server' && serverId) {
    const [global] = await pool.execute<RowDataPacket[]>(
      'SELECT max_participants FROM call_participant_limits WHERE scope_type = ? AND scope_id = ?',
      [category, 'global']
    );
    if (global.length > 0) return global[0].max_participants as number;
  }
  return DEFAULT_LIMITS[category];
}

async function countActiveParticipants(callId: string): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT COUNT(*) AS cnt FROM call_participants WHERE call_id = ? AND left_at IS NULL',
    [callId]
  );
  return (rows[0].cnt as number) || 0;
}

// ============ ROUTES METRICS / HEALTH ============

app.get('/health', async (_req, res) => {
  try {
    await pool.execute('SELECT 1');
    await redis.ping();
    res.json({ status: 'ok', service: 'calls' });
  } catch (error) {
    res.status(503).json({ status: 'error', service: 'calls', detail: (error as Error).message });
  }
});

app.get('/metrics', (_req, res) => {
  res.json({
    service: 'calls',
    serviceId: process.env.SERVICE_ID || 'calls-default',
    location: (process.env.SERVICE_LOCATION || 'EU').toUpperCase(),
    ...collectServiceMetrics(),
    uptime: process.uptime(),
  });
});

// ============ ROUTES SPÉCIFIQUES (avant les routes paramétrées) ============

// GET /calls/history/:userId — historique des appels d'un utilisateur
app.get('/calls/history/:userId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params;
    if (userId !== req.userId) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    const [calls] = await pool.execute<RowDataPacket[]>(
      `SELECT c.id, c.type, c.call_category, c.initiator_id, c.channel_id,
              c.server_id, c.status, c.current_quality_tier,
              c.started_at, c.ended_at, cp.joined_at, cp.left_at
       FROM calls c
       JOIN call_participants cp ON c.id = cp.call_id
       WHERE cp.user_id = ?
       ORDER BY c.started_at DESC
       LIMIT ?`,
      [userId, limit]
    );

    res.json(calls);
  } catch (error) {
    logger.error('Erreur historique appels:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /calls/limits/:serverId — limite personnalisée par serveur (ou globale)
app.get('/calls/limits/:serverId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { serverId } = req.params;
    const limit = await getParticipantLimit('server', serverId);
    res.json({ serverId, maxParticipants: limit });
  } catch (error) {
    logger.error('Erreur récupération limite:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============ CRÉATION D'APPELS ============

// POST /calls/dm — Initier un appel DM (2 participants max)
app.post('/calls/dm', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { type, conversationId } = req.body;
    const initiatorId = req.userId;

    if (!initiatorId) return res.status(401).json({ error: 'Authentification requise' });
    if (!type || !['voice', 'video'].includes(type)) {
      return res.status(400).json({ error: "type doit être 'voice' ou 'video'" });
    }

    const callId = uuidv4();

    await pool.execute(
      `INSERT INTO calls (id, type, call_category, initiator_id, conversation_id, status)
       VALUES (?, ?, 'dm', ?, ?, 'ringing')`,
      [callId, type, initiatorId, conversationId || null]
    );
    await pool.execute(
      'INSERT INTO call_participants (call_id, user_id) VALUES (?, ?)',
      [callId, initiatorId]
    );

    const callData = {
      id: callId, type, callCategory: 'dm', initiatorId,
      conversationId: conversationId || null,
      status: 'ringing', participants: [initiatorId],
      startedAt: new Date().toISOString(),
    };
    await redis.setex(`call:${callId}`, 3600, JSON.stringify(callData));

    logger.info(`Appel DM créé: ${callId} (${type}) par ${initiatorId}`);
    res.status(201).json(callData);
  } catch (error) {
    logger.error('Erreur création appel DM:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /calls/group — Créer un appel groupe (≤100, P2P puis SFU)
app.post('/calls/group', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { channelId, type } = req.body;
    const initiatorId = req.userId;

    if (!channelId || !initiatorId) {
      return res.status(400).json({ error: 'channelId requis et authentification nécessaire' });
    }

    const callId = uuidv4();

    await pool.execute(
      `INSERT INTO calls (id, type, call_category, initiator_id, channel_id, status)
       VALUES (?, ?, 'group', ?, ?, 'ringing')`,
      [callId, type || 'voice', initiatorId, channelId]
    );
    await pool.execute(
      'INSERT INTO call_participants (call_id, user_id) VALUES (?, ?)',
      [callId, initiatorId]
    );

    const callData = {
      id: callId, type: type || 'voice', callCategory: 'group',
      channelId, status: 'ringing', initiatorId,
      participants: [initiatorId], startedAt: new Date().toISOString(),
    };
    await redis.setex(`call:${callId}`, 3600, JSON.stringify(callData));

    logger.info(`Appel groupe créé: ${callId} channel=${channelId} par ${initiatorId}`);
    res.status(201).json(callData);
  } catch (error) {
    logger.error('Erreur création appel groupe:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /calls/server — Créer un appel serveur/communauté (≤1500, SFU)
app.post('/calls/server', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { channelId, serverId, type } = req.body;
    const initiatorId = req.userId;

    if (!channelId || !serverId || !initiatorId) {
      return res.status(400).json({ error: 'channelId et serverId requis' });
    }

    // Vérifier si un appel actif existe déjà sur ce canal
    const [existing] = await pool.execute<RowDataPacket[]>(
      "SELECT id FROM calls WHERE channel_id = ? AND call_category = 'server' AND status IN ('ringing','ongoing')",
      [channelId]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Un appel est déjà actif sur ce canal', existingCallId: existing[0].id });
    }

    const callId = uuidv4();

    await pool.execute(
      `INSERT INTO calls (id, type, call_category, initiator_id, channel_id, server_id, status)
       VALUES (?, ?, 'server', ?, ?, ?, 'ongoing')`,
      [callId, type || 'voice', initiatorId, channelId, serverId]
    );
    await pool.execute(
      'INSERT INTO call_participants (call_id, user_id) VALUES (?, ?)',
      [callId, initiatorId]
    );

    const callData = {
      id: callId, type: type || 'voice', callCategory: 'server',
      channelId, serverId, status: 'ongoing', initiatorId,
      currentQualityTier: 0, participants: [initiatorId],
      startedAt: new Date().toISOString(),
    };
    await redis.setex(`call:${callId}`, 3600, JSON.stringify(callData));

    logger.info(`Appel serveur créé: ${callId} channel=${channelId} serveur=${serverId}`);
    res.status(201).json(callData);
  } catch (error) {
    logger.error('Erreur création appel serveur:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /calls — Compat. ancien client (→ appel DM)
app.post('/calls', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { type, conversationId } = req.body;
    const initiatorId = req.userId;

    if (!initiatorId) return res.status(401).json({ error: 'Authentification requise' });
    if (!type || !['voice', 'video'].includes(type)) {
      return res.status(400).json({ error: "type doit être 'voice' ou 'video'" });
    }

    const callId = uuidv4();

    await pool.execute(
      `INSERT INTO calls (id, type, call_category, initiator_id, conversation_id, status)
       VALUES (?, ?, 'dm', ?, ?, 'ringing')`,
      [callId, type, initiatorId, conversationId || null]
    );
    await pool.execute(
      'INSERT INTO call_participants (call_id, user_id) VALUES (?, ?)',
      [callId, initiatorId]
    );

    const callData = {
      id: callId, type, callCategory: 'dm', initiatorId,
      conversationId: conversationId || null,
      status: 'ringing', participants: [initiatorId],
      startedAt: new Date().toISOString(),
    };
    await redis.setex(`call:${callId}`, 3600, JSON.stringify(callData));

    logger.info(`Appel DM créé (compat): ${callId}`);
    res.status(201).json(callData);
  } catch (error) {
    logger.error('Erreur création appel:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============ ROUTES PAR CALL ID ============

// GET /calls/:callId — Récupérer un appel
app.get('/calls/:callId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { callId } = req.params;

    const cached = await redis.get(`call:${callId}`);
    if (cached) return res.json(JSON.parse(cached));

    const [calls] = await pool.execute<RowDataPacket[]>(
      'SELECT * FROM calls WHERE id = ?',
      [callId]
    );

    if (calls.length === 0) {
      return res.status(404).json({ error: 'Appel non trouvé' });
    }

    const [participants] = await pool.execute<RowDataPacket[]>(
      'SELECT user_id FROM call_participants WHERE call_id = ? AND left_at IS NULL',
      [callId]
    );

    const call = calls[0];
    const callData = {
      id: call.id,
      type: call.type,
      callCategory: call.call_category as CallCategory,
      initiatorId: call.initiator_id,
      channelId: call.channel_id,
      conversationId: call.conversation_id,
      serverId: call.server_id,
      status: call.status,
      currentQualityTier: (call.current_quality_tier ?? 0) as QualityTier,
      startedAt: call.started_at,
      endedAt: call.ended_at,
      participants: participants.map((p) => p.user_id as string),
    };
    res.json(callData);
  } catch (error) {
    logger.error('Erreur récupération appel:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /calls/:callId/quality — Tier courant + count (utilisé par gateway)
app.get('/calls/:callId/quality', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { callId } = req.params;

    const [calls] = await pool.execute<RowDataPacket[]>(
      'SELECT call_category, current_quality_tier FROM calls WHERE id = ?',
      [callId]
    );
    if (calls.length === 0) return res.status(404).json({ error: 'Appel non trouvé' });

    const participantCount = await countActiveParticipants(callId);
    res.json({
      callId,
      tier: calls[0].current_quality_tier as QualityTier,
      participantCount,
      callCategory: calls[0].call_category as CallCategory,
    });
  } catch (error) {
    logger.error('Erreur récupération qualité:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /calls/:callId/quality — Mise à jour tier (appelé par media-server, interne)
app.post('/calls/:callId/quality', internalAuth, async (req: Request, res: Response) => {
  try {
    const { callId } = req.params;
    const { tier, reason, participantCount } = req.body as {
      tier: QualityTier; reason: string; participantCount: number;
    };

    if (tier === undefined || tier < 0 || tier > 3) {
      return res.status(400).json({ error: 'tier doit être entre 0 et 3' });
    }

    await pool.execute(
      'UPDATE calls SET current_quality_tier = ? WHERE id = ?',
      [tier, callId]
    );

    await pool.execute(
      `INSERT INTO call_quality_events (call_id, tier, reason, participant_count)
       VALUES (?, ?, ?, ?)`,
      [callId, tier, reason || 'participant_count', participantCount || 0]
    );

    await redis.del(`call:${callId}`);

    logger.info(`Tier qualité mis à jour: ${callId} → tier ${tier} (${participantCount} participants)`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Erreur mise à jour qualité:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /calls/:callId/join — Rejoindre un appel
app.post('/calls/:callId/join', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { callId } = req.params;
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Authentification requise' });

    const [calls] = await pool.execute<RowDataPacket[]>(
      "SELECT * FROM calls WHERE id = ? AND status IN ('ringing', 'ongoing')",
      [callId]
    );

    if (calls.length === 0) {
      return res.status(404).json({ error: 'Appel non trouvé ou terminé' });
    }

    const call = calls[0];
    const category = call.call_category as CallCategory;

    // Vérifier la limite de participants
    const currentCount = await countActiveParticipants(callId);
    const maxAllowed = await getParticipantLimit(category, call.server_id);

    // Pour les DM, s'assurer qu'il n'y a pas déjà 2 participants
    if (category === 'dm' && currentCount >= 2) {
      return res.status(403).json({ error: 'CALL_FULL', maxParticipants: 2 });
    }
    if (currentCount >= maxAllowed) {
      return res.status(403).json({ error: 'CALL_FULL', maxParticipants: maxAllowed });
    }

    await pool.execute(
      'INSERT IGNORE INTO call_participants (call_id, user_id) VALUES (?, ?)',
      [callId, userId]
    );

    await pool.execute(
      "UPDATE calls SET status = 'ongoing' WHERE id = ? AND status = 'ringing'",
      [callId]
    );

    await redis.del(`call:${callId}`);

    logger.info(`${userId} a rejoint l'appel ${callId} (${category})`);
    res.json({ success: true, callCategory: category });
  } catch (error) {
    logger.error('Erreur rejoindre appel:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /calls/:callId/reject — Refuser un appel DM
app.post('/calls/:callId/reject', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { callId } = req.params;
    const userId = req.userId;

    const [active] = await pool.execute<RowDataPacket[]>(
      'SELECT user_id FROM call_participants WHERE call_id = ? AND user_id != ? AND left_at IS NULL',
      [callId, userId || '']
    );

    if (active.length <= 1) {
      await pool.execute(
        "UPDATE calls SET status = 'missed', ended_at = NOW() WHERE id = ?",
        [callId]
      );
      await redis.del(`call:${callId}`);
    }

    logger.info(`${userId || 'unknown'} a refusé l'appel ${callId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Erreur refus appel:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /calls/:callId/leave — Quitter un appel (sans le terminer pour les autres)
app.post('/calls/:callId/leave', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { callId } = req.params;
    const userId = req.userId;

    await pool.execute(
      'UPDATE call_participants SET left_at = NOW() WHERE call_id = ? AND user_id = ? AND left_at IS NULL',
      [callId, userId]
    );

    const remaining = await countActiveParticipants(callId);

    if (remaining === 0) {
      await pool.execute(
        "UPDATE calls SET status = 'ended', ended_at = NOW() WHERE id = ?",
        [callId]
      );
    }
    await redis.del(`call:${callId}`);

    logger.info(`${userId} a quitté l'appel ${callId} (${remaining} restants)`);
    res.json({ success: true, remainingParticipants: remaining });
  } catch (error) {
    logger.error('Erreur quitter appel:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /calls/:callId/end — Terminer un appel (pour tous)
app.post('/calls/:callId/end', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { callId } = req.params;
    const userId = req.userId;

    const [participants] = await pool.execute<RowDataPacket[]>(
      'SELECT user_id FROM call_participants WHERE call_id = ? AND user_id = ?',
      [callId, userId]
    );
    if (participants.length === 0) {
      return res.status(403).json({ error: 'Non autorisé à terminer cet appel' });
    }

    await pool.execute(
      "UPDATE calls SET status = 'ended', ended_at = NOW() WHERE id = ?",
      [callId]
    );
    await pool.execute(
      'UPDATE call_participants SET left_at = NOW() WHERE call_id = ? AND left_at IS NULL',
      [callId]
    );
    await redis.del(`call:${callId}`);

    logger.info(`Appel ${callId} terminé par ${userId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Erreur fin appel:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============ DÉMARRAGE ============

async function start() {
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'alfychat',
      password: process.env.DB_PASSWORD || 'alfychat',
      database: process.env.DB_NAME || 'alfychat',
      waitForConnections: true,
      connectionLimit: parseInt(process.env.DB_POOL_SIZE || '5'),
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      connectTimeout: 10000,
      idleTimeout: 60000,
    });

    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6379');
    const redisPassword = process.env.REDIS_PASSWORD || undefined;

    redis = new Redis({
      host: redisHost,
      port: redisPort,
      password: redisPassword,
      connectTimeout: 5000,
      retryStrategy: (times) => Math.min(50 + times * 50, 2000),
      reconnectOnError: (err) => /ETIMEDOUT|ECONNREFUSED|READONLY/.test(err.message || ''),
      maxRetriesPerRequest: null,
    } as any);

    redis.on('error', (err) => logger.error('Redis error', err));
    redis.on('ready', () => logger.info('Redis ready'));

    // ===== MIGRATIONS =====

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS calls (
        id VARCHAR(36) PRIMARY KEY,
        type ENUM('voice', 'video') NOT NULL,
        call_category ENUM('dm', 'group', 'server') NOT NULL DEFAULT 'dm',
        initiator_id VARCHAR(36) NOT NULL,
        channel_id VARCHAR(36) NULL DEFAULT NULL,
        conversation_id VARCHAR(100) NULL DEFAULT NULL,
        server_id VARCHAR(36) NULL DEFAULT NULL,
        status ENUM('ringing', 'ongoing', 'ended', 'missed') DEFAULT 'ringing',
        current_quality_tier TINYINT UNSIGNED NOT NULL DEFAULT 0,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP NULL DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS call_participants (
        call_id VARCHAR(36) NOT NULL,
        user_id VARCHAR(36) NOT NULL,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        left_at TIMESTAMP NULL DEFAULT NULL,
        is_muted BOOLEAN DEFAULT FALSE,
        is_video_enabled BOOLEAN DEFAULT FALSE,
        is_screen_sharing BOOLEAN DEFAULT FALSE,
        PRIMARY KEY (call_id, user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS call_participant_limits (
        scope_type ENUM('dm', 'group', 'server') NOT NULL,
        scope_id VARCHAR(36) NOT NULL,
        max_participants INT UNSIGNED NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (scope_type, scope_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS call_quality_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        call_id VARCHAR(36) NOT NULL,
        tier TINYINT UNSIGNED NOT NULL,
        reason VARCHAR(50) NOT NULL DEFAULT 'participant_count',
        participant_count INT UNSIGNED NOT NULL DEFAULT 0,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_call (call_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Limites par défaut
    await pool.execute(`
      INSERT IGNORE INTO call_participant_limits (scope_type, scope_id, max_participants) VALUES
        ('dm',     'global', 2),
        ('group',  'global', 100),
        ('server', 'global', 1500)
    `);

    // Migrations non-destructives — MySQL 8.0 compatible (pas de IF NOT EXISTS sur ADD COLUMN/ADD INDEX)
    const addColIfMissing = async (table: string, column: string, definition: string) => {
      const [rows] = await pool.execute<RowDataPacket[]>(
        'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column],
      );
      if (rows.length === 0) await pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    };

    const addIdxIfMissing = async (table: string, indexName: string, definition: string) => {
      const [rows] = await pool.execute<RowDataPacket[]>(
        'SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
        [table, indexName],
      );
      if (rows.length === 0) await pool.execute(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` ${definition}`);
    };

    await addColIfMissing('calls', 'call_category', "ENUM('dm','group','server') NOT NULL DEFAULT 'dm'");
    await addColIfMissing('calls', 'conversation_id', 'VARCHAR(100) NULL DEFAULT NULL');
    await addColIfMissing('calls', 'server_id', 'VARCHAR(36) NULL DEFAULT NULL');
    await addColIfMissing('calls', 'current_quality_tier', 'TINYINT UNSIGNED NOT NULL DEFAULT 0');

    await addIdxIfMissing('call_participants', 'idx_user_id', '(user_id)');
    await addIdxIfMissing('call_participants', 'idx_call_active', '(call_id, left_at)');
    await addIdxIfMissing('calls', 'idx_status', '(status)');
    await addIdxIfMissing('calls', 'idx_category', '(call_category)');
    await addIdxIfMissing('calls', 'idx_channel_category', '(channel_id, call_category)');

    const PORT = process.env.PORT || 3004;
    app.listen(PORT, () => {
      logger.info(`Service Calls démarré sur le port ${PORT}`);
      startServiceRegistration('calls');
    });
  } catch (error) {
    logger.error('Erreur au démarrage:', error);
    process.exit(1);
  }
}

// -- HTML error pages (browser content-negotiation) --------------------------
app.get('/', (req, res, next) => {
  if (req.accepts(['html', 'json']) === 'html')
    return res.sendFile(path.join(__dirname, '../public/index.html'));
  next();
});
app.use((req, res) => {
  if (req.accepts(['html', 'json']) === 'html')
    return res.status(404).sendFile(path.join(__dirname, '../public/errors/404.html'));
  res.status(404).json({ error: 'Route not found', path: req.path });
});
app.use((err: any, req: any, res: any, _next: any) => {
  if (req.accepts(['html', 'json']) === 'html')
    return res.status(500).sendFile(path.join(__dirname, '../public/errors/500.html'));
  res.status(500).json({ error: 'Internal server error' });
});

start();

export { app, logger };
