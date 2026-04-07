// ==========================================
// ALFYCHAT - SERVICE APPELS
// ==========================================

import { v4 as uuidv4 } from 'uuid';
import { getDatabase, getRedis } from '../index';
import { Call, CallParticipant, CreateCallDTO, UpdateParticipantDTO } from '../types/call';

export class CallService {
  private get db() {
    return getDatabase();
  }

  private get redis() {
    return getRedis();
  }

  // Créer un appel
  async create(dto: CreateCallDTO): Promise<Call> {
    const callId = uuidv4();

    await this.db.execute(
      `INSERT INTO calls (id, channel_id, initiator_id, type, status)
       VALUES (?, ?, ?, ?, 'ringing')`,
      [callId, dto.channelId ?? null, dto.initiatorId, dto.type]
    );

    // Ajouter l'initiateur comme participant
    await this.addParticipant(callId, dto.initiatorId);

    // Notifier les autres participants via Redis pub/sub
    for (const userId of dto.participantIds) {
      if (userId !== dto.initiatorId) {
        await this.redis.publish('call:incoming', JSON.stringify({
          callId,
          initiatorId: dto.initiatorId,
          userId,
          type: dto.type,
        }));
      }
    }

    return this.getById(callId) as Promise<Call>;
  }

  // Récupérer un appel
  async getById(callId: string): Promise<Call | null> {
    const [rows] = await this.db.query(
      'SELECT * FROM calls WHERE id = ?',
      [callId]
    );

    if ((rows as any[]).length === 0) return null;

    const call = (rows as any[])[0];
    const participants = await this.getParticipants(callId);

    return {
      id: call.id,
      channelId: call.channel_id,
      initiatorId: call.initiator_id,
      type: call.type,
      status: call.status,
      startedAt: call.started_at,
      endedAt: call.ended_at,
      participants,
    };
  }

  // Rejoindre un appel
  async join(callId: string, userId: string): Promise<CallParticipant> {
    // Vérifier que l'appel existe et est actif
    const call = await this.getById(callId);
    if (!call || call.status === 'ended') {
      throw new Error('Appel non disponible');
    }

    // Si c'est le premier à répondre (hors initiateur), démarrer l'appel
    if (call.status === 'ringing' && call.participants.length === 1) {
      await this.db.execute(
        `UPDATE calls SET status = 'active' WHERE id = ?`,
        [callId]
      );
    }

    return this.addParticipant(callId, userId);
  }

  // Quitter un appel
  async leave(callId: string, userId: string): Promise<void> {
    await this.db.execute(
      `UPDATE call_participants SET left_at = NOW() 
       WHERE call_id = ? AND user_id = ? AND left_at IS NULL`,
      [callId, userId]
    );

    // Vérifier s'il reste des participants
    const [remaining] = await this.db.query(
      `SELECT COUNT(*) as count FROM call_participants 
       WHERE call_id = ? AND left_at IS NULL`,
      [callId]
    );

    // Si plus de participants, terminer l'appel
    if ((remaining as any[])[0].count <= 1) {
      await this.end(callId);
    }
  }

  // Terminer un appel
  async end(callId: string): Promise<void> {
    await this.db.execute(
      `UPDATE calls SET status = 'ended', ended_at = NOW() WHERE id = ?`,
      [callId]
    );

    // Marquer tous les participants comme ayant quitté
    await this.db.execute(
      `UPDATE call_participants SET left_at = NOW() 
       WHERE call_id = ? AND left_at IS NULL`,
      [callId]
    );

    // Notifier via Redis
    await this.redis.publish('call:ended', JSON.stringify({ callId }));
  }

  // Mettre à jour l'état d'un participant
  async updateParticipant(callId: string, userId: string, dto: UpdateParticipantDTO): Promise<void> {
    const updates: string[] = [];
    const params: any[] = [];

    if (dto.isMuted !== undefined) {
      updates.push('is_muted = ?');
      params.push(dto.isMuted);
    }
    if (dto.isDeafened !== undefined) {
      updates.push('is_deafened = ?');
      params.push(dto.isDeafened);
    }
    if (dto.isVideoEnabled !== undefined) {
      updates.push('is_video_enabled = ?');
      params.push(dto.isVideoEnabled);
    }

    if (updates.length > 0) {
      params.push(callId, userId);
      await this.db.execute(
        `UPDATE call_participants SET ${updates.join(', ')} 
         WHERE call_id = ? AND user_id = ?`,
        params
      );
    }
  }

  // Récupérer les appels actifs d'un utilisateur
  async getActiveCallsForUser(userId: string): Promise<Call[]> {
    const [rows] = await this.db.query(
      `SELECT DISTINCT c.* FROM calls c
       JOIN call_participants cp ON c.id = cp.call_id
       WHERE cp.user_id = ? AND c.status != 'ended' AND cp.left_at IS NULL`,
      [userId]
    );

    return Promise.all((rows as any[]).map(async (call) => {
      const participants = await this.getParticipants(call.id);
      return {
        id: call.id,
        channelId: call.channel_id,
        initiatorId: call.initiator_id,
        type: call.type,
        status: call.status,
        startedAt: call.started_at,
        endedAt: call.ended_at,
        participants,
      };
    }));
  }

  // Helpers privés
  private async addParticipant(callId: string, userId: string): Promise<CallParticipant> {
    const participantId = uuidv4();

    await this.db.execute(
      `INSERT INTO call_participants (id, call_id, user_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE left_at = NULL`,
      [participantId, callId, userId]
    );

    return {
      id: participantId,
      callId,
      userId,
      joinedAt: new Date(),
      isMuted: false,
      isDeafened: false,
      isVideoEnabled: false,
    };
  }

  private async getParticipants(callId: string): Promise<CallParticipant[]> {
    const [rows] = await this.db.query(
      `SELECT cp.*, u.username, u.display_name, u.avatar_url
       FROM call_participants cp
       JOIN users u ON cp.user_id = u.id
       WHERE cp.call_id = ?`,
      [callId]
    );

    return (rows as any[]).map(p => ({
      id: p.id,
      callId: p.call_id,
      userId: p.user_id,
      joinedAt: p.joined_at,
      leftAt: p.left_at,
      isMuted: Boolean(p.is_muted),
      isDeafened: Boolean(p.is_deafened),
      isVideoEnabled: Boolean(p.is_video_enabled),
      user: {
        id: p.user_id,
        username: p.username,
        displayName: p.display_name,
        avatarUrl: p.avatar_url,
      },
    }));
  }
}

export const callService = new CallService();
