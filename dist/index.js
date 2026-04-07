"use strict";
// ==========================================
// ALFYCHAT - SERVICE APPELS
// Gestion des appels vocaux et vidéo (WebRTC)
// ==========================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.app = void 0;
exports.getDatabase = getDatabase;
exports.getRedis = getRedis;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const dotenv_1 = __importDefault(require("dotenv"));
const express_2 = require("express");
const express_validator_1 = require("express-validator");
const uuid_1 = require("uuid");
const promise_1 = __importDefault(require("mysql2/promise"));
const ioredis_1 = __importDefault(require("ioredis"));
const winston_1 = __importDefault(require("winston"));
dotenv_1.default.config();
const app = (0, express_1.default)();
exports.app = app;
app.use((0, cors_1.default)());
app.use((0, helmet_1.default)());
app.use(express_1.default.json());
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.simple()),
    transports: [new winston_1.default.transports.Console()],
});
exports.logger = logger;
let pool;
let redis;
function getDatabase() {
    return pool;
}
function getRedis() {
    return redis;
}
function getDb() {
    return {
        async query(sql, params) {
            const [rows] = await pool.execute(sql, params);
            return [rows];
        },
        async execute(sql, params) {
            const [result] = await pool.execute(sql, params);
            return result;
        },
    };
}
const callsRouter = (0, express_2.Router)();
// Initier un appel
callsRouter.post('/', (0, express_validator_1.body)('type').isIn(['voice', 'video']), (0, express_validator_1.body)('initiatorId').isUUID(), async (req, res) => {
    try {
        const errors = (0, express_validator_1.validationResult)(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        const { type, initiatorId, conversationId, channelId } = req.body;
        const db = getDb();
        const callId = (0, uuid_1.v4)();
        await db.execute(`INSERT INTO calls (id, type, initiator_id, conversation_id, channel_id, status)
         VALUES (?, ?, ?, ?, ?, 'ringing')`, [callId, type, initiatorId, conversationId, channelId]);
        // Ajouter l'initiateur comme participant
        await db.execute('INSERT INTO call_participants (call_id, user_id) VALUES (?, ?)', [callId, initiatorId]);
        // Stocker les infos de l'appel dans Redis pour un accès rapide
        await redis.setex(`call:${callId}`, 3600, JSON.stringify({
            id: callId,
            type,
            initiatorId,
            conversationId,
            channelId,
            status: 'ringing',
            participants: [initiatorId],
            startedAt: new Date(),
        }));
        logger.info(`Appel initié: ${callId} (${type}) par ${initiatorId}`);
        res.status(201).json({
            id: callId,
            type,
            initiatorId,
            conversationId,
            channelId,
            status: 'ringing',
            participants: [{ userId: initiatorId, joinedAt: new Date() }],
        });
    }
    catch (error) {
        logger.error('Erreur création appel:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Récupérer un appel
callsRouter.get('/:callId', async (req, res) => {
    try {
        const { callId } = req.params;
        // Vérifier d'abord dans Redis
        const cached = await redis.get(`call:${callId}`);
        if (cached) {
            return res.json(JSON.parse(cached));
        }
        const db = getDb();
        const [calls] = await db.query('SELECT * FROM calls WHERE id = ?', [callId]);
        if (calls.length === 0) {
            return res.status(404).json({ error: 'Appel non trouvé' });
        }
        const [participants] = await db.query('SELECT * FROM call_participants WHERE call_id = ?', [callId]);
        res.json({
            ...calls[0],
            participants,
        });
    }
    catch (error) {
        logger.error('Erreur récupération appel:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Rejoindre un appel
callsRouter.post('/:callId/join', (0, express_validator_1.body)('userId').isUUID(), async (req, res) => {
    try {
        const { callId } = req.params;
        const { userId } = req.body;
        const db = getDb();
        // Vérifier que l'appel existe et est actif
        const [calls] = await db.query("SELECT * FROM calls WHERE id = ? AND status IN ('ringing', 'ongoing')", [callId]);
        if (calls.length === 0) {
            return res.status(404).json({ error: 'Appel non trouvé ou terminé' });
        }
        // Ajouter le participant
        await db.execute('INSERT IGNORE INTO call_participants (call_id, user_id) VALUES (?, ?)', [callId, userId]);
        // Mettre à jour le statut si nécessaire
        await db.execute("UPDATE calls SET status = 'ongoing' WHERE id = ? AND status = 'ringing'", [callId]);
        // Mettre à jour Redis
        const cached = await redis.get(`call:${callId}`);
        if (cached) {
            const call = JSON.parse(cached);
            if (!call.participants.includes(userId)) {
                call.participants.push(userId);
            }
            call.status = 'ongoing';
            await redis.setex(`call:${callId}`, 3600, JSON.stringify(call));
        }
        logger.info(`${userId} a rejoint l'appel ${callId}`);
        res.json({ success: true });
    }
    catch (error) {
        logger.error('Erreur rejoindre appel:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Refuser un appel
callsRouter.post('/:callId/reject', (0, express_validator_1.body)('userId').isUUID(), async (req, res) => {
    try {
        const { callId } = req.params;
        const { userId } = req.body;
        const db = getDb();
        // Vérifier s'il reste des participants
        const [participants] = await db.query('SELECT user_id FROM call_participants WHERE call_id = ? AND user_id != ?', [callId, userId]);
        if (participants.length === 0) {
            // Terminer l'appel si plus personne
            await db.execute("UPDATE calls SET status = 'missed', ended_at = NOW() WHERE id = ?", [callId]);
            await redis.del(`call:${callId}`);
        }
        logger.info(`${userId} a refusé l'appel ${callId}`);
        res.json({ success: true });
    }
    catch (error) {
        logger.error('Erreur refus appel:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Quitter un appel
callsRouter.post('/:callId/leave', (0, express_validator_1.body)('userId').isUUID(), async (req, res) => {
    try {
        const { callId } = req.params;
        const { userId } = req.body;
        const db = getDb();
        // Marquer le participant comme parti
        await db.execute('UPDATE call_participants SET left_at = NOW() WHERE call_id = ? AND user_id = ?', [callId, userId]);
        // Vérifier s'il reste des participants actifs
        const [active] = await db.query('SELECT user_id FROM call_participants WHERE call_id = ? AND left_at IS NULL', [callId]);
        if (active.length === 0) {
            await db.execute("UPDATE calls SET status = 'ended', ended_at = NOW() WHERE id = ?", [callId]);
            await redis.del(`call:${callId}`);
        }
        else {
            // Mettre à jour Redis
            const cached = await redis.get(`call:${callId}`);
            if (cached) {
                const call = JSON.parse(cached);
                call.participants = call.participants.filter((p) => p !== userId);
                await redis.setex(`call:${callId}`, 3600, JSON.stringify(call));
            }
        }
        logger.info(`${userId} a quitté l'appel ${callId}`);
        res.json({ success: true });
    }
    catch (error) {
        logger.error('Erreur quitter appel:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Terminer un appel
callsRouter.post('/:callId/end', (0, express_validator_1.body)('userId').isUUID(), async (req, res) => {
    try {
        const { callId } = req.params;
        const db = getDb();
        await db.execute("UPDATE calls SET status = 'ended', ended_at = NOW() WHERE id = ?", [callId]);
        await db.execute('UPDATE call_participants SET left_at = NOW() WHERE call_id = ? AND left_at IS NULL', [callId]);
        await redis.del(`call:${callId}`);
        logger.info(`Appel ${callId} terminé`);
        res.json({ success: true });
    }
    catch (error) {
        logger.error('Erreur fin appel:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Mettre à jour l'état d'un participant (mute, vidéo, partage d'écran)
callsRouter.patch('/:callId/participants/:userId', async (req, res) => {
    try {
        const { callId, userId } = req.params;
        const { isMuted, isVideoEnabled, isScreenSharing } = req.body;
        const db = getDb();
        const updates = [];
        const params = [];
        if (isMuted !== undefined) {
            updates.push('is_muted = ?');
            params.push(isMuted);
        }
        if (isVideoEnabled !== undefined) {
            updates.push('is_video_enabled = ?');
            params.push(isVideoEnabled);
        }
        if (isScreenSharing !== undefined) {
            updates.push('is_screen_sharing = ?');
            params.push(isScreenSharing);
        }
        if (updates.length > 0) {
            params.push(callId, userId);
            await db.execute(`UPDATE call_participants SET ${updates.join(', ')} WHERE call_id = ? AND user_id = ?`, params);
        }
        res.json({ success: true });
    }
    catch (error) {
        logger.error('Erreur mise à jour participant:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
// Historique des appels
callsRouter.get('/history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit = 50 } = req.query;
        const db = getDb();
        const [calls] = await db.query(`SELECT c.*, cp.joined_at, cp.left_at
       FROM calls c
       JOIN call_participants cp ON c.id = cp.call_id
       WHERE cp.user_id = ?
       ORDER BY c.started_at DESC
       LIMIT ?`, [userId, parseInt(limit)]);
        res.json(calls);
    }
    catch (error) {
        logger.error('Erreur historique appels:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
app.use('/calls', callsRouter);
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'calls' });
});
async function start() {
    try {
        pool = promise_1.default.createPool({
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '3306'),
            user: process.env.DB_USER || 'alfychat',
            password: process.env.DB_PASSWORD || 'alfychat',
            database: process.env.DB_NAME || 'alfychat',
            connectionLimit: 10,
        });
        redis = new ioredis_1.default({
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            password: process.env.REDIS_PASSWORD,
        });
        // Migrations
        await pool.execute(`
      CREATE TABLE IF NOT EXISTS calls (
        id VARCHAR(36) PRIMARY KEY,
        type ENUM('voice', 'video') NOT NULL,
        initiator_id VARCHAR(36) NOT NULL,
        channel_id VARCHAR(36),
        conversation_id VARCHAR(36),
        status ENUM('ringing', 'ongoing', 'ended', 'missed') DEFAULT 'ringing',
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
        await pool.execute(`
      CREATE TABLE IF NOT EXISTS call_participants (
        call_id VARCHAR(36) NOT NULL,
        user_id VARCHAR(36) NOT NULL,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        left_at TIMESTAMP,
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
    }
    catch (error) {
        logger.error('Erreur au démarrage:', error);
        process.exit(1);
    }
}
start();
//# sourceMappingURL=index.js.map