# AlfyChat — Service Appels

Microservice de gestion des appels audio/vidéo pour AlfyChat.

![Node.js](https://img.shields.io/badge/Bun-1.2-black?logo=bun)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)
![LiveKit](https://img.shields.io/badge/LiveKit-SFU-00A86B)
![License](https://img.shields.io/badge/License-Source_Available-blue)

## Rôle

Ce service gère les appels 1:1 et de groupe via le protocole WebRTC, avec [LiveKit](https://livekit.io/) comme SFU (Selective Forwarding Unit). Il génère les tokens d'accès LiveKit et gère l'état des sessions d'appel.

## Stack technique

| Catégorie | Technologies |
|-----------|-------------|
| Runtime | Bun |
| Langage | TypeScript |
| API | Express |
| Appels temps réel | LiveKit (SFU) |
| Auth | JWT |
| Cache | Redis |
| Base de données | MySQL 8 |

## Architecture globale

```
Frontend (:4000)  →  Gateway (:3000)  →  Microservices
                                          ├── users    (:3001)
                                          ├── messages  (:3002)
                                          ├── friends   (:3003)
                                          ├── calls     (:3004)  ← ce service
                                          ├── servers   (:3005)
                                          ├── bots      (:3006)
                                          └── media     (:3007)
```

## Démarrage

### Prérequis

- [Bun](https://bun.sh/) ≥ 1.2
- MySQL 8
- Redis 7
- Serveur LiveKit

### Variables d'environnement

```env
PORT=3004
DB_HOST=localhost
DB_PORT=3306
DB_USER=alfychat
DB_PASSWORD=
DB_NAME=alfychat_calls
REDIS_URL=redis://localhost:6379
JWT_SECRET=
LIVEKIT_URL=wss://livekit.example.com
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
SERVICE_REGISTRY_URL=http://gateway:3000
```

### Installation

```bash
bun install
```

### Développement

```bash
bun run dev
```

### Build production

```bash
bun run build
bun run start
```

### Docker

```bash
docker compose up calls
```

## Structure du projet

```
src/
├── index.ts             # Point d'entrée
├── controllers/         # Logique métier (appels, rooms LiveKit)
├── routes/              # Définition des routes Express
├── services/            # Services (LiveKit, DB, cache)
├── middleware/          # Auth JWT, rate limiting
├── types/               # Types TypeScript
└── utils/               # Utilitaires
```

## Contribution

Voir [CONTRIBUTING.md](./CONTRIBUTING.md).
