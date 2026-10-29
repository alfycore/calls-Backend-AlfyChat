// ==========================================
// ALFYCHAT - SERVICE APPELS
// Gestion des appels DM / groupe / serveur (WebRTC)
// ==========================================

package main

import (
	"context"
	"log/slog"

	"github.com/alfychat/calls/internal/calls"
	"github.com/alfychat/calls/internal/platform"
)

func main() {
	platform.LoadEnv()
	platform.InitLogger()

	srv := platform.NewServer()
	auth := platform.NewAuth()
	auth.Loose = true
	auth.InternalWithoutUser = true

	db, err := platform.OpenDatabaseSized("alfychat", "alfychat", platform.EnvInt("DB_POOL_SIZE", 5))
	if err != nil {
		platform.Fatal("Erreur au démarrage", err)
	}
	rdb, err := platform.NewRedis()
	if err != nil {
		platform.Fatal("Erreur au démarrage", err)
	}
	if err := calls.Migrate(context.Background(), db); err != nil {
		platform.Fatal("Erreur au démarrage", err)
	}

	calls.Register(srv, db, rdb, auth)

	port := platform.Env("PORT", "3004")
	err = srv.Listen(port, func() {
		slog.Info("Service Calls démarré sur le port " + port)
		platform.StartServiceRegistration("calls")
	})
	if err != nil {
		platform.Fatal("Erreur au démarrage", err)
	}
}
