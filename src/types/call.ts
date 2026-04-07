// ==========================================
// ALFYCHAT - TYPES APPELS
// ==========================================

export type CallType = 'voice' | 'video';
export type CallStatus = 'ringing' | 'active' | 'ended';

export interface Call {
  id: string;
  channelId?: string;
  initiatorId: string;
  type: CallType;
  status: CallStatus;
  startedAt: Date;
  endedAt?: Date;
  participants: CallParticipant[];
}

export interface CallParticipant {
  id: string;
  callId: string;
  userId: string;
  joinedAt: Date;
  leftAt?: Date;
  isMuted: boolean;
  isDeafened: boolean;
  isVideoEnabled: boolean;
  user?: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
  };
}

export interface CreateCallDTO {
  initiatorId: string;
  channelId?: string;
  participantIds: string[];
  type: CallType;
}

export interface JoinCallDTO {
  callId: string;
  userId: string;
}

export interface UpdateParticipantDTO {
  isMuted?: boolean;
  isDeafened?: boolean;
  isVideoEnabled?: boolean;
}
