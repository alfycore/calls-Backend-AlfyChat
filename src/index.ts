// ==========================================
// ALFYCHAT - SERVICE APPELS
// Gestion des appels vocaux et vidéo (WebRTC)
// ==========================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import mysql, { Pool, RowDataPacket } from 'mysql2/promise';
import Redis from 'ioredis';
import winston from 'winston';

dotenv.config();

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json());

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
app.post('/calls', async (req, res) => {
  try {
    const { type, initiatorId, conversationId, channelId } = req.body;

    if (!type || !initiatorId) {
      return res.status(400).json({ error: 'type et initiatorId requis' });
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
app.get('/calls/:callId', async (req, res) => {
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
app.post('/calls/:callId/join', async (req, res) => {
  try {
    const { callId } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId requis' });

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

    // Mettre à jour Redis
    const cached = await redis.get(`call:${callId}`);
    if (cached) {
      const call = JSON.parse(cached);
      if (!call.participants.includes(userId)) call.participants.push(userId);
      call.status = 'ongoing';
      await redis.setex(`call:${callId}`, 3600, JSON.stringify(call));
    }

    logger.info(`${userId} a rejoint l'appel ${callId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Erreur rejoindre appel:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /calls/:callId/reject — Refuser un appel
app.post('/calls/:callId/reject', async (req, res) => {
  try {
    const { callId } = req.params;
    const { userId } = req.body;

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
app.post('/calls/:callId/leave', async (req, res) => {
  try {
    const { callId } = req.params;
    const { userId } = req.body;

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
      await redis.del(`call:${callId}`);
    } else {
      const cached = await redis.get(`call:${callId}`);
      if (cached) {
        const call = JSON.parse(cached);
        call.participants = call.participants.filter((p: string) => p !== userId);
        await redis.setex(`call:${callId}`, 3600, JSON.stringify(call));
      }
    }

    logger.info(`${userId} a quitté l'appel ${callId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Erreur quitter appel:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /calls/:callId/end — Terminer un appel
app.post('/calls/:callId/end', async (req, res) => {
  try {
    const { callId } = req.params;

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

// GET /calls/history/:userId — Historique des appels
app.get('/calls/history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
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

// Health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'calls' });
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
      connectionLimit: 10,
    });

    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
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

    const PORT = process.env.PORT || 3004;
    app.listen(PORT, () => {
      logger.info(`🚀 Service Calls démarré sur le port ${PORT}`);
    });
  } catch (error) {
    logger.error('Erreur au démarrage:', error);
    process.exit(1);
  }
}

start();

export { app, logger };
