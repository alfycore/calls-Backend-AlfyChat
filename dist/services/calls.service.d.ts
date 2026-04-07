import { Call, CallParticipant, CreateCallDTO, UpdateParticipantDTO } from '../types/call';
export declare class CallService {
    private get db();
    private get redis();
    create(dto: CreateCallDTO): Promise<Call>;
    getById(callId: string): Promise<Call | null>;
    join(callId: string, userId: string): Promise<CallParticipant>;
    leave(callId: string, userId: string): Promise<void>;
    end(callId: string): Promise<void>;
    updateParticipant(callId: string, userId: string, dto: UpdateParticipantDTO): Promise<void>;
    getActiveCallsForUser(userId: string): Promise<Call[]>;
    private addParticipant;
    private getParticipants;
}
export declare const callService: CallService;
//# sourceMappingURL=calls.service.d.ts.map