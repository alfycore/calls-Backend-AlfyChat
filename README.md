# AlfyChat — Service Appels

Microservice de gestion des appels audio/vidéo pour AlfyChat.

![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go)
![LiveKit](https://img.shields.io/badge/LiveKit-SFU-00A86B)
![License](https://img.shields.io/badge/License-Source_Available-blue)

## Rôle

Ce service gère les appels 1:1 et de groupe via le protocole WebRTC, avec [LiveKit](https://livekit.io/) comme SFU (Selective Forwarding Unit). Il génère les tokens d'accès LiveKit et gère l'état des sessions d'appel.

## Stack technique

| Catégorie | Technologies |
|-----------|-------------|
| Langage | Go 1.26 |
| API | net/http (stdlib) |
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

- [Go](https://go.dev/) ≥ 1.26
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

### Développement

```bash
go run .
```

### Build production

```bash
go build -o bin/service .
./bin/service
```

### Tests

```bash
go test ./...
```

### Docker

```bash
docker compose up calls
```

## Structure du projet

```
main.go                  # Point d'entrée
internal/
├── calls/               # Routes, cache Redis, limites de participants
└── platform/            # Socle commun aux services Go
```

## Contribution

Voir [CONTRIBUTING.md](./CONTRIBUTING.md).
