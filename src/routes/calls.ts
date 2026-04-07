// ==========================================
// ALFYCHAT - ROUTES APPELS
// ==========================================

import { Router } from 'express';
import { body, param } from 'express-validator';
import { callController } from '../controllers/calls.controller';
import { validateRequest } from '../middleware/validate';

export const callsRouter = Router();

callsRouter.post('/',
  body('initiatorId').isUUID(),
  body('participantIds').isArray({ min: 1 }),
  body('participantIds.*').isUUID(),
  body('type').isIn(['voice', 'video']),
  body('channelId').optional().isUUID(),
  validateRequest,
  callController.create.bind(callController)
);

callsRouter.get('/user/:userId/active',
  param('userId').isUUID(),
  validateRequest,
  callController.getActiveCallsForUser.bind(callController)
);

callsRouter.get('/:callId',
  param('callId').isUUID(),
  validateRequest,
  callController.getById.bind(callController)
);

callsRouter.post('/:callId/join',
  param('callId').isUUID(),
  body('userId').isUUID(),
  validateRequest,
  callController.join.bind(callController)
);

callsRouter.post('/:callId/leave',
  param('callId').isUUID(),
  body('userId').isUUID(),
  validateRequest,
  callController.leave.bind(callController)
);

callsRouter.post('/:callId/end',
  param('callId').isUUID(),
  validateRequest,
  callController.end.bind(callController)
);

callsRouter.patch('/:callId/participants/:userId',
  param('callId').isUUID(),
  param('userId').isUUID(),
  body('isMuted').optional().isBoolean(),
  body('isDeafened').optional().isBoolean(),
  body('isVideoEnabled').optional().isBoolean(),
  validateRequest,
  callController.updateParticipant.bind(callController)
);
