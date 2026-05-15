// ==========================================
// ALFYCHAT - TYPES APPELS
// ==========================================

export type CallType = 'voice' | 'video';
export type CallStatus = 'ringing' | 'ongoing' | 'ended' | 'missed';
export type CallCategory = 'dm' | 'group' | 'server';
export type QualityTier = 0 | 1 | 2 | 3;

export interface Call {
  id: string;
  type: CallType;
  callCategory: CallCategory;
  initiatorId: string;
  channelId?: string;
  conversationId?: string;
  serverId?: string;
  status: CallStatus;
  currentQualityTier: QualityTier;
  startedAt: Date;
  endedAt?: Date;
  participants: string[];
}

export interface CallParticipant {
  callId: string;
  userId: string;
  joinedAt: Date;
  leftAt?: Date;
  isMuted: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
}

export interface ParticipantLimit {
  scopeType: CallCategory;
  scopeId: string;
  maxParticipants: number;
}

export interface QualityEvent {
  callId: string;
  tier: QualityTier;
  reason: 'participant_count' | 'network_degraded';
  participantCount: number;
}

export interface CreateDmCallDTO {
  type: CallType;
  initiatorId: string;
  conversationId?: string;
}

export interface CreateGroupCallDTO {
  type: CallType;
  initiatorId: string;
  channelId: string;
}

export interface CreateServerCallDTO {
  type: CallType;
  initiatorId: string;
  channelId: string;
  serverId: string;
}
