// ==========================================
// ALFYCHAT - SERVICE APPELS
// Gestion des appels vocaux et vidéo (WebRTC)
// ==========================================

import dotenv from 'dotenv';
dotenv.config();
import { registerGlobalErrorHandlers } from './utils/error-reporter';
registerGlobalErrorHandlers();
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';
import mysql, { Pool, RowDataPacket } from 'mysql2/promise';
import Redis from 'ioredis';
import winston from 'winston';
import { AccessToken } from 'livekit-server-sdk';
import { startServiceRegistration, serviceMetricsMiddleware, collectServiceMetrics } from './utils/service-client';
import { authMiddleware, AuthRequest } from './middleware/auth';

dotenv.config();

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

export function getDatabase() {
  return pool;
}

export function getRedis() {
  return redis;
}

// ============ ROUTES ============

// POST /calls — Initier un appel
app.post('/calls', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { type, conversationId, channelId } = req.body;
    const initiatorId = req.userId;

    if (!type || !initiatorId) {
      return res.status(400).json({ error: 'type requis et authentification nécessaire' });
    }
    if (!['voice', 'video'].includes(type)) {
      return res.status(400).json({ error: 'type doit être voice ou video' });
    }

    const callId = uuidv4();

    await pool.execute(
      `INSERT INTO calls (id, type, initiator_id, conversation_id, channel_id, status)
       VALUES (?, ?, ?, ?, ?, 'ringing')`,
      [callId, type, initiatorId, conversationId || null, channelId || null]
    );

    await pool.execute(
      'INSERT INTO call_participants (call_id, user_id) VALUES (?, ?)',
      [callId, initiatorId]
    );

    const callData = {
      id: callId,
      type,
      initiatorId,
      conversationId: conversationId || null,
      channelId: channelId || null,
      status: 'ringing',
      participants: [initiatorId],
      startedAt: new Date().toISOString(),
    };

    await redis.setex(`call:${callId}`, 3600, JSON.stringify(callData));

    logger.info(`Appel créé: ${callId} (${type}) par ${initiatorId}`);
    res.status(201).json(callData);
  } catch (error) {
    logger.error('Erreur création appel:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /calls/:callId — Récupérer un appel
app.get('/calls/:callId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { callId } = req.params;

    // Vérifier le cache Redis
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
      'SELECT * FROM call_participants WHERE call_id = ?',
      [callId]
    );

    const call = calls[0];
    res.json({
      id: call.id,
      type: call.type,
      initiatorId: call.initiator_id,
      conversationId: call.conversation_id,
      channelId: call.channel_id,
      status: call.status,
      startedAt: call.started_at,
      endedAt: call.ended_at,
      participants: participants.map((p) => p.user_id),
    });
  } catch (error) {
    logger.error('Erreur récupération appel:', error);
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

    // Ajouter le participant
    await pool.execute(
      'INSERT IGNORE INTO call_participants (call_id, user_id) VALUES (?, ?)',
      [callId, userId]
    );

    // Passer en ongoing si ringing
    await pool.execute(
      "UPDATE calls SET status = 'ongoing' WHERE id = ? AND status = 'ringing'",
      [callId]
    );

    // Invalider le cache Redis — la prochaine lecture reconstruira depuis la DB
    // (évite le race condition get-modify-set entre plusieurs instances)
    await redis.del(`call:${callId}`);

    logger.info(`${userId} a rejoint l'appel ${callId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Erreur rejoindre appel:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /calls/:callId/reject — Refuser un appel
app.post('/calls/:callId/reject', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { callId } = req.params;
    const userId = req.userId;

    // Vérifier s'il reste des participants
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

// POST /calls/:callId/leave — Quitter un appel
app.post('/calls/:callId/leave', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { callId } = req.params;
    const userId = req.userId;

    await pool.execute(
      'UPDATE call_participants SET left_at = NOW() WHERE call_id = ? AND user_id = ? AND left_at IS NULL',
      [callId, userId]
    );

    // Vérifier s'il reste des participants actifs
    const [active] = await pool.execute<RowDataPacket[]>(
      'SELECT user_id FROM call_participants WHERE call_id = ? AND left_at IS NULL',
      [callId]
    );

    if (active.length === 0) {
      await pool.execute(
        "UPDATE calls SET status = 'ended', ended_at = NOW() WHERE id = ?",
        [callId]
      );
    }
    // Invalider le cache dans tous les cas — évite le race condition entre instances
    await redis.del(`call:${callId}`);

    logger.info(`${userId} a quitté l'appel ${callId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Erreur quitter appel:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /calls/:callId/end — Terminer un appel
app.post('/calls/:callId/end', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { callId } = req.params;
    const userId = req.userId;

    // Vérifier que l'utilisateur est participant de l'appel
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

    logger.info(`Appel ${callId} terminé`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Erreur fin appel:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============ APPELS GROUPE (LiveKit SFU) ============
// Les appels groupe utilisent LiveKit comme SFU (Selective Forwarding Unit),
// contrairement aux appels DM qui utilisent le WebRTC P2P mesh existant.
// Variables d'environnement requises : LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_WS_URL

function buildLiveKitToken(participantId: string, participantName: string, roomName: string): string {
  const apiKey    = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error('LIVEKIT_API_KEY / LIVEKIT_API_SECRET non configurés');

  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantId,
    name: participantName,
    ttl: '30m',
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return token.toJwt() as unknown as string;
}

// POST /calls/group/room — Créer une room LiveKit pour un appel groupe (initiateur)
app.post('/calls/group/room', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { channelId, participantName, type } = req.body;
    const participantId = req.userId;

    if (!channelId || !participantId) {
      return res.status(400).json({ error: 'channelId requis et authentification nécessaire' });
    }

    // Vérifier que le créateur est membre du serveur avant d'ouvrir la room.
    const [chk] = await pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM channels c
       JOIN server_members sm ON sm.server_id = c.server_id
       WHERE c.id = ? AND sm.user_id = ? LIMIT 1`,
      [channelId, participantId]
    );
    if ((chk as any[]).length === 0) {
      return res.status(403).json({ error: 'Accès refusé: non membre du serveur' });
    }

    const callId   = uuidv4();
    const roomName = `group_${channelId}_${callId}`;
    const wsUrl    = process.env.LIVEKIT_WS_URL;

    if (!wsUrl || !process.env.LIVEKIT_API_KEY) {
      return res.status(503).json({
        error: 'LiveKit non configuré — définir LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_WS_URL',
      });
    }

    const token = buildLiveKitToken(participantId, participantName || participantId, roomName);

    // Stocker la session dans Redis (1h TTL)
    const callData = {
      id:          callId,
      type:        type || 'voice',
      channelId,
      roomName,
      wsUrl,
      status:      'ringing',
      initiatorId: participantId,
      createdAt:   new Date().toISOString(),
    };
    await redis.setex(`group_call:${callId}`, 3600, JSON.stringify(callData));

    // Enregistrer dans la DB pour l'historique
    await pool.execute(
      `INSERT INTO calls (id, type, initiator_id, channel_id, status)
       VALUES (?, ?, ?, ?, 'ringing')`,
      [callId, type || 'voice', participantId, channelId]
    );
    await pool.execute(
      'INSERT INTO call_participants (call_id, user_id) VALUES (?, ?)',
      [callId, participantId]
    );

    logger.info(`Appel groupe créé: ${callId} room=${roomName} par ${participantId}`);
    res.status(201).json({ callId, roomName, token, wsUrl });
  } catch (error) {
    logger.error('Erreur création appel groupe:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Helper: vérifier qu'un utilisateur est membre du serveur propriétaire d'un channel
async function userCanAccessChannel(userId: string, channelId: string): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT 1
     FROM channels c
     JOIN server_members sm ON sm.server_id = c.server_id
     WHERE c.id = ? AND sm.user_id = ?
     LIMIT 1`,
    [channelId, userId]
  );
  return (rows as any[]).length > 0;
}

// POST /calls/group/token — Rejoindre une room LiveKit existante (autres participants)
app.post('/calls/group/token', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { callId, participantName } = req.body;
    const participantId = req.userId;

    if (!callId || !participantId) {
      return res.status(400).json({ error: 'callId requis et authentification nécessaire' });
    }

    const cached = await redis.get(`group_call:${callId}`);
    if (!cached) return res.status(404).json({ error: 'Appel groupe non trouvé ou expiré' });

    const callData = JSON.parse(cached);

    // Vérifier l'appartenance au serveur propriétaire du channel avant d'émettre un token LiveKit.
    if (callData.channelId) {
      const allowed = await userCanAccessChannel(participantId, callData.channelId);
      if (!allowed) {
        return res.status(403).json({ error: 'Accès refusé: non membre du serveur' });
      }
    }

    const token = buildLiveKitToken(participantId, participantName || participantId, callData.roomName);

    // Marquer le participant dans la DB
    await pool.execute(
      'INSERT IGNORE INTO call_participants (call_id, user_id) VALUES (?, ?)',
      [callId, participantId]
    );
    await pool.execute(
      "UPDATE calls SET status = 'ongoing' WHERE id = ? AND status = 'ringing'",
      [callId]
    );

    logger.info(`Token généré pour ${participantId} dans appel groupe ${callId}`);
    res.json({ token, roomName: callData.roomName, wsUrl: callData.wsUrl });
  } catch (error) {
    logger.error('Erreur token appel groupe:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /calls/group/:callId/end — Terminer un appel groupe (initiateur uniquement)
app.post('/calls/group/:callId/end', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { callId } = req.params;
    const userId = req.userId;

    const cached = await redis.get(`group_call:${callId}`);
    if (cached) {
      const callData = JSON.parse(cached);
      if (callData.initiatorId && callData.initiatorId !== userId) {
        return res.status(403).json({ error: 'Seul l\'initiateur peut terminer l\'appel' });
      }
    } else {
      // Fallback DB si la session Redis a expiré
      const [rows] = await pool.execute<RowDataPacket[]>(
        'SELECT initiator_id FROM calls WHERE id = ? LIMIT 1',
        [callId]
      );
      const row = (rows as any[])[0];
      if (row && row.initiator_id && row.initiator_id !== userId) {
        return res.status(403).json({ error: 'Seul l\'initiateur peut terminer l\'appel' });
      }
    }

    await redis.del(`group_call:${callId}`);
    await pool.execute(
      "UPDATE calls SET status = 'ended', ended_at = NOW() WHERE id = ?",
      [callId]
    );
    await pool.execute(
      'UPDATE call_participants SET left_at = NOW() WHERE call_id = ? AND left_at IS NULL',
      [callId]
    );
    logger.info(`Appel groupe ${callId} terminé`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Erreur fin appel groupe:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /calls/history/:userId — Historique des appels
app.get('/calls/history/:userId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params;
    // L'utilisateur ne peut voir que son propre historique
    if (userId !== req.userId) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }
    const limit = parseInt(req.query.limit as string) || 50;

    const [calls] = await pool.execute<RowDataPacket[]>(
      `SELECT c.*, cp.joined_at, cp.left_at
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

// Health — vérifie MySQL et Redis pour que le load balancer route correctement
app.get('/health', async (_req, res) => {
  try {
    await pool.execute('SELECT 1');
    await redis.ping();
    res.json({ status: 'ok', service: 'calls' });
  } catch (error) {
    res.status(503).json({ status: 'error', service: 'calls', detail: (error as Error).message });
  }
});

app.get('/metrics', (req, res) => {
  res.json({
    service: 'calls',
    serviceId: process.env.SERVICE_ID || 'calls-default',
    location: (process.env.SERVICE_LOCATION || 'EU').toUpperCase(),
    ...collectServiceMetrics(),
    uptime: process.uptime(),
  });
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
      connectionLimit: parseInt(process.env.DB_POOL_SIZE || '5'),
    });

    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6379');
    const redisPassword = process.env.REDIS_PASSWORD || undefined;

    const redisOptions = {
      host: redisHost,
      port: redisPort,
      password: redisPassword,
      connectTimeout: 5000,
      // Allow ioredis to retry with backoff
      retryStrategy: (times: number) => Math.min(50 + times * 50, 2000),
      // Let ioredis decide reconnection on certain errors
      reconnectOnError: (err: Error) => {
        if (!err) return false;
        // reconnect on network/timeouts or if Redis replies READONLY
        const msg = err.message || '';
        return /ETIMEDOUT|ECONNREFUSED|READONLY/.test(msg);
      },
      maxRetriesPerRequest: null,
    } as any;

    redis = new Redis(redisOptions);

    // Attach event handlers to avoid unhandled error events and log state
    redis.on('error', (err: Error) => {
      logger.error('Redis error', err);
    });
    redis.on('connect', () => {
      logger.info('Redis connecting', { host: redisHost, port: redisPort });
    });
    redis.on('ready', () => {
      logger.info('Redis ready');
    });
    redis.on('close', () => {
      logger.warn('Redis connection closed');
    });
    redis.on('reconnecting', (time: number) => {
      logger.warn(`Redis reconnecting in ${time}ms`);
    });

    // Migration des tables
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS calls (
        id VARCHAR(36) PRIMARY KEY,
        type ENUM('voice', 'video') NOT NULL,
        initiator_id VARCHAR(36) NOT NULL,
        channel_id VARCHAR(36) NULL DEFAULT NULL,
        conversation_id VARCHAR(100) NULL DEFAULT NULL,
        status ENUM('ringing', 'ongoing', 'ended', 'missed') DEFAULT 'ringing',
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

    // Index pour accélérer les requêtes multi-instances à l'échelle
    await pool.execute(`
      ALTER TABLE call_participants
        ADD INDEX IF NOT EXISTS idx_user_id (user_id),
        ADD INDEX IF NOT EXISTS idx_call_active (call_id, left_at)
    `).catch(() => { /* index existe déjà */ });

    await pool.execute(`
      ALTER TABLE calls
        ADD INDEX IF NOT EXISTS idx_status (status)
    `).catch(() => { /* index existe déjà */ });

    const PORT = process.env.PORT || 3004;
    app.listen(PORT, () => {
      logger.info(`🚀 Service Calls démarré sur le port ${PORT}`);
      startServiceRegistration('calls');
    });
  } catch (error) {
    logger.error('Erreur au démarrage:', error);
    process.exit(1);
  }
}

start();

export { app, logger };
