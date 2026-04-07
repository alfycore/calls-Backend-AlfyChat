// ==========================================
// ALFYCHAT - CONTRÔLEUR APPELS
// ==========================================

import { Request, Response } from 'express';
import { CallService } from '../services/calls.service';
import { logger } from '../index';

const callService = new CallService();

export class CallController {
  async create(req: Request, res: Response) {
    try {
      const { initiatorId, channelId, participantIds, type } = req.body;
      const call = await callService.create({ initiatorId, channelId, participantIds, type });
      logger.info(`Appel créé: ${call.id}`);
      res.status(201).json(call);
    } catch (error) {
      logger.error('Erreur création appel:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const { callId } = req.params;
      const call = await callService.getById(callId);
      if (!call) {
        return res.status(404).json({ error: 'Appel non trouvé' });
      }
      res.json(call);
    } catch (error) {
      logger.error('Erreur récupération appel:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  async join(req: Request, res: Response) {
    try {
      const { callId } = req.params;
      const { userId } = req.body;
      const participant = await callService.join(callId, userId);
      logger.info(`Utilisateur ${userId} a rejoint l'appel ${callId}`);
      res.json(participant);
    } catch (error: any) {
      logger.error('Erreur join appel:', error);
      res.status(400).json({ error: error.message });
    }
  }

  async leave(req: Request, res: Response) {
    try {
      const { callId } = req.params;
      const { userId } = req.body;
      await callService.leave(callId, userId);
      logger.info(`Utilisateur ${userId} a quitté l'appel ${callId}`);
      res.json({ success: true });
    } catch (error) {
      logger.error('Erreur leave appel:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  async end(req: Request, res: Response) {
    try {
      const { callId } = req.params;
      await callService.end(callId);
      logger.info(`Appel terminé: ${callId}`);
      res.json({ success: true });
    } catch (error) {
      logger.error('Erreur fin appel:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  async updateParticipant(req: Request, res: Response) {
    try {
      const { callId, userId } = req.params;
      await callService.updateParticipant(callId, userId, req.body);
      res.json({ success: true });
    } catch (error) {
      logger.error('Erreur mise à jour participant:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  async getActiveCallsForUser(req: Request, res: Response) {
    try {
      const { userId } = req.params;
      const calls = await callService.getActiveCallsForUser(userId);
      res.json(calls);
    } catch (error) {
      logger.error('Erreur récupération appels actifs:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
}

export const callController = new CallController();
