"use strict";
// ==========================================
// ALFYCHAT - ROUTES APPELS
// ==========================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.callsRouter = void 0;
const express_1 = require("express");
const express_validator_1 = require("express-validator");
const calls_controller_1 = require("../controllers/calls.controller");
const validate_1 = require("../middleware/validate");
exports.callsRouter = (0, express_1.Router)();
exports.callsRouter.post('/', (0, express_validator_1.body)('initiatorId').isUUID(), (0, express_validator_1.body)('participantIds').isArray({ min: 1 }), (0, express_validator_1.body)('participantIds.*').isUUID(), (0, express_validator_1.body)('type').isIn(['voice', 'video']), (0, express_validator_1.body)('channelId').optional().isUUID(), validate_1.validateRequest, calls_controller_1.callController.create.bind(calls_controller_1.callController));
exports.callsRouter.get('/user/:userId/active', (0, express_validator_1.param)('userId').isUUID(), validate_1.validateRequest, calls_controller_1.callController.getActiveCallsForUser.bind(calls_controller_1.callController));
exports.callsRouter.get('/:callId', (0, express_validator_1.param)('callId').isUUID(), validate_1.validateRequest, calls_controller_1.callController.getById.bind(calls_controller_1.callController));
exports.callsRouter.post('/:callId/join', (0, express_validator_1.param)('callId').isUUID(), (0, express_validator_1.body)('userId').isUUID(), validate_1.validateRequest, calls_controller_1.callController.join.bind(calls_controller_1.callController));
exports.callsRouter.post('/:callId/leave', (0, express_validator_1.param)('callId').isUUID(), (0, express_validator_1.body)('userId').isUUID(), validate_1.validateRequest, calls_controller_1.callController.leave.bind(calls_controller_1.callController));
exports.callsRouter.post('/:callId/end', (0, express_validator_1.param)('callId').isUUID(), validate_1.validateRequest, calls_controller_1.callController.end.bind(calls_controller_1.callController));
exports.callsRouter.patch('/:callId/participants/:userId', (0, express_validator_1.param)('callId').isUUID(), (0, express_validator_1.param)('userId').isUUID(), (0, express_validator_1.body)('isMuted').optional().isBoolean(), (0, express_validator_1.body)('isDeafened').optional().isBoolean(), (0, express_validator_1.body)('isVideoEnabled').optional().isBoolean(), validate_1.validateRequest, calls_controller_1.callController.updateParticipant.bind(calls_controller_1.callController));
//# sourceMappingURL=calls.js.map