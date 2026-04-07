"use strict";
// ==========================================
// ALFYCHAT - CONTRÔLEUR APPELS
// ==========================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.callController = exports.CallController = void 0;
const calls_service_1 = require("../services/calls.service");
const index_1 = require("../index");
const callService = new calls_service_1.CallService();
class CallController {
    async create(req, res) {
        try {
            const { initiatorId, channelId, participantIds, type } = req.body;
            const call = await callService.create({ initiatorId, channelId, participantIds, type });
            index_1.logger.info(`Appel créé: ${call.id}`);
            res.status(201).json(call);
        }
        catch (error) {
            index_1.logger.error('Erreur création appel:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    async getById(req, res) {
        try {
            const { callId } = req.params;
            const call = await callService.getById(callId);
            if (!call) {
                return res.status(404).json({ error: 'Appel non trouvé' });
            }
            res.json(call);
        }
        catch (error) {
            index_1.logger.error('Erreur récupération appel:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    async join(req, res) {
        try {
            const { callId } = req.params;
            const { userId } = req.body;
            const participant = await callService.join(callId, userId);
            index_1.logger.info(`Utilisateur ${userId} a rejoint l'appel ${callId}`);
            res.json(participant);
        }
        catch (error) {
            index_1.logger.error('Erreur join appel:', error);
            res.status(400).json({ error: error.message });
        }
    }
    async leave(req, res) {
        try {
            const { callId } = req.params;
            const { userId } = req.body;
            await callService.leave(callId, userId);
            index_1.logger.info(`Utilisateur ${userId} a quitté l'appel ${callId}`);
            res.json({ success: true });
        }
        catch (error) {
            index_1.logger.error('Erreur leave appel:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    async end(req, res) {
        try {
            const { callId } = req.params;
            await callService.end(callId);
            index_1.logger.info(`Appel terminé: ${callId}`);
            res.json({ success: true });
        }
        catch (error) {
            index_1.logger.error('Erreur fin appel:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    async updateParticipant(req, res) {
        try {
            const { callId, userId } = req.params;
            await callService.updateParticipant(callId, userId, req.body);
            res.json({ success: true });
        }
        catch (error) {
            index_1.logger.error('Erreur mise à jour participant:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
    async getActiveCallsForUser(req, res) {
        try {
            const { userId } = req.params;
            const calls = await callService.getActiveCallsForUser(userId);
            res.json(calls);
        }
        catch (error) {
            index_1.logger.error('Erreur récupération appels actifs:', error);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    }
}
exports.CallController = CallController;
exports.callController = new CallController();
//# sourceMappingURL=calls.controller.js.map