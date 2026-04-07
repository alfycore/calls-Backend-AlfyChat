import { Request, Response } from 'express';
export declare class CallController {
    create(req: Request, res: Response): Promise<void>;
    getById(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
    join(req: Request, res: Response): Promise<void>;
    leave(req: Request, res: Response): Promise<void>;
    end(req: Request, res: Response): Promise<void>;
    updateParticipant(req: Request, res: Response): Promise<void>;
    getActiveCallsForUser(req: Request, res: Response): Promise<void>;
}
export declare const callController: CallController;
//# sourceMappingURL=calls.controller.d.ts.map