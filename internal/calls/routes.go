// ==========================================
// ALFYCHAT - SERVICE APPELS
// Gestion des appels DM / groupe / serveur (WebRTC).
// ==========================================

package calls

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/alfychat/calls/internal/platform"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type handlers struct {
	db   *platform.DB
	rdb  *redis.Client
	auth *platform.Auth
}

var defaultLimits = map[string]int64{"dm": 2, "group": 100, "server": 1500}

// dmIDRe : identifiant de conversation DM « dm_<uuid>_<uuid> ».
var dmIDRe = regexp.MustCompile(`(?i)^dm_([0-9a-f-]{36})_([0-9a-f-]{36})$`)

func fail(w http.ResponseWriter, logMsg string, err error) {
	slog.Error(logMsg, "err", err)
	platform.Error(w, http.StatusInternalServerError, "Erreur serveur")
}

func callKey(id string) string { return "call:" + id }

// Register déclare les routes du service. L'ordre est celui d'Express : les
// routes spécifiques (history, limits) précèdent /calls/:callId.
func Register(srv *platform.Server, db *platform.DB, rdb *redis.Client, auth *platform.Auth) {
	h := &handlers{db: db, rdb: rdb, auth: auth}
	a := auth.Require
	srv.Mount("/calls")

	srv.Handle("GET /health", h.health)
	srv.Handle("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		body := platform.O(
			"service", "calls",
			"serviceId", platform.Env("SERVICE_ID", "calls-default"),
			"location", strings.ToUpper(platform.Env("SERVICE_LOCATION", "EU")),
		)
		m := platform.CollectServiceMetrics()
		for _, k := range m.Keys() {
			body.Set(k, m.Get(k))
		}
		body.Set("uptime", platform.Uptime())
		platform.JSON(w, 200, body)
	})

	srv.Handle("GET /calls/history/{userId}", a(h.history))
	srv.Handle("GET /calls/limits/{serverId}", a(h.limits))
	srv.Handle("POST /calls/dm", a(h.createDM("Appel DM créé: ", "Erreur création appel DM:")))
	srv.Handle("POST /calls/group", a(h.createGroup))
	srv.Handle("POST /calls/server", a(h.createServer))
	srv.Handle("POST /calls", a(h.createDM("Appel DM créé (compat): ", "Erreur création appel:")))
	srv.Handle("GET /calls/{callId}", a(h.get))
	srv.Handle("GET /calls/{callId}/quality", a(h.getQuality))
	srv.Handle("POST /calls/{callId}/quality", h.internalAuth(h.setQuality))
	srv.Handle("POST /calls/{callId}/join", a(h.join))
	srv.Handle("POST /calls/{callId}/reject", a(h.reject))
	srv.Handle("POST /calls/{callId}/leave", a(h.leave))
	srv.Handle("POST /calls/{callId}/end", a(h.end))
}

// internalAuth : appels internes (media-server → calls).
func (h *handlers) internalAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		secret := r.Header.Get("X-Internal-Secret")
		if secret == "" || secret != h.auth.InternalSecret() {
			platform.Error(w, 401, "Accès interne requis")
			return
		}
		next(w, r)
	}
}

func (h *handlers) health(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	_, err := h.db.Exec(ctx, "SELECT 1")
	if err == nil {
		err = h.rdb.Ping(ctx).Err()
	}
	if err != nil {
		platform.JSON(w, 503, platform.O("status", "error", "service", "calls", "detail", err.Error()))
		return
	}
	platform.JSON(w, 200, platform.O("status", "ok", "service", "calls"))
}

// ── Limites et appartenance ──────────────────────────────────────────────

func (h *handlers) participantLimit(ctx context.Context, category string, serverID any) (int64, error) {
	scopeID := "global"
	hasServer := category == "server" && platform.Truthy(serverID)
	if hasServer {
		scopeID = platform.JSString(serverID)
	}
	row, err := h.db.First(ctx, "SELECT max_participants FROM call_participant_limits WHERE scope_type = ? AND scope_id = ?", category, scopeID)
	if err != nil {
		return 0, err
	}
	if row != nil {
		return row.Int("max_participants"), nil
	}
	// Repli sur la limite globale pour les serveurs sans limite personnalisée.
	if hasServer {
		global, err := h.db.First(ctx, "SELECT max_participants FROM call_participant_limits WHERE scope_type = ? AND scope_id = ?", category, "global")
		if err != nil {
			return 0, err
		}
		if global != nil {
			return global.Int("max_participants"), nil
		}
	}
	return defaultLimits[category], nil
}

func (h *handlers) countActive(ctx context.Context, callID string) (int64, error) {
	row, err := h.db.First(ctx, "SELECT COUNT(*) AS cnt FROM call_participants WHERE call_id = ? AND left_at IS NULL", callID)
	if err != nil || row == nil {
		return 0, err
	}
	return row.Int("cnt"), nil
}

// isConversationMember : l'appartenance se vérifie en SQL (base partagée).
func (h *handlers) isConversationMember(ctx context.Context, userID string, conversationID any) (bool, error) {
	if !platform.Truthy(conversationID) || userID == "" {
		return false, nil
	}
	if m := dmIDRe.FindStringSubmatch(platform.JSString(conversationID)); m != nil {
		return m[1] == userID || m[2] == userID, nil
	}
	rows, err := h.db.Rows(ctx, "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1",
		platform.SQLParam(conversationID), userID)
	return len(rows) > 0, err
}

func (h *handlers) isServerMember(ctx context.Context, userID string, serverID any) (bool, error) {
	if !platform.Truthy(serverID) || userID == "" {
		return false, nil
	}
	sid := platform.SQLParam(serverID)
	rows, err := h.db.Rows(ctx,
		`SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?
     UNION SELECT 1 FROM servers WHERE id = ? AND owner_id = ? LIMIT 1`,
		sid, userID, sid, userID)
	return len(rows) > 0, err
}

// canAccessCall : l'utilisateur peut-il voir / rejoindre cet appel ?
func (h *handlers) canAccessCall(ctx context.Context, userID string, call *platform.Object) (bool, error) {
	switch call.Str("call_category") {
	case "server":
		return h.isServerMember(ctx, userID, call.Get("server_id"))
	case "group":
		return h.isConversationMember(ctx, userID, call.Get("channel_id"))
	}
	return h.isConversationMember(ctx, userID, call.Get("conversation_id"))
}

func (h *handlers) loadCall(ctx context.Context, callID string) (*platform.Object, error) {
	return h.db.First(ctx, "SELECT * FROM calls WHERE id = ?", callID)
}

// store garde l'appel en cache Redis une heure.
func (h *handlers) store(ctx context.Context, callID string, data *platform.Object) error {
	return h.rdb.SetEx(ctx, callKey(callID), platform.JSONString(data), time.Hour).Err()
}

func (h *handlers) forget(ctx context.Context, callID string) error {
	return h.rdb.Del(ctx, callKey(callID)).Err()
}

// ── Lecture ───────────────────────────────────────────────────────────────

// GET /calls/history/:userId
func (h *handlers) history(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")
	if userID != platform.UserID(r) || platform.UserID(r) == "" && userID == "" {
		platform.Error(w, 403, "Accès non autorisé")
		return
	}
	limit := platform.ParseIntOr(platform.Query(r).Get("limit"), 50)
	limit = math.Min(limit, 200)
	rows, err := h.db.Rows(r.Context(),
		`SELECT c.id, c.type, c.call_category, c.initiator_id, c.channel_id,
              c.server_id, c.status, c.current_quality_tier,
              c.started_at, c.ended_at, cp.joined_at, cp.left_at
       FROM calls c
       JOIN call_participants cp ON c.id = cp.call_id
       WHERE cp.user_id = ?
       ORDER BY c.started_at DESC
       LIMIT ?`, userID, int64(limit))
	if err != nil {
		fail(w, "Erreur historique appels:", err)
		return
	}
	platform.JSON(w, 200, rows)
}

// GET /calls/limits/:serverId
func (h *handlers) limits(w http.ResponseWriter, r *http.Request) {
	serverID := r.PathValue("serverId")
	limit, err := h.participantLimit(r.Context(), "server", serverID)
	if err != nil {
		fail(w, "Erreur récupération limite:", err)
		return
	}
	platform.JSON(w, 200, platform.O("serverId", serverID, "maxParticipants", limit))
}

// GET /calls/:callId
func (h *handlers) get(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	callID, userID := r.PathValue("callId"), platform.UserID(r)
	call, err := h.loadCall(ctx, callID)
	if err != nil {
		fail(w, "Erreur récupération appel:", err)
		return
	}
	if call == nil {
		platform.Error(w, 404, "Appel non trouvé")
		return
	}
	// Lecture réservée aux ayants droit (les appels internes sans x-user-id
	// — le gateway — passent).
	if userID != "" {
		ok, err := h.canAccessCall(ctx, userID, call)
		if err != nil {
			fail(w, "Erreur récupération appel:", err)
			return
		}
		if !ok {
			platform.Error(w, 403, "Accès non autorisé")
			return
		}
	}

	cached, err := h.rdb.Get(ctx, callKey(callID)).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		fail(w, "Erreur récupération appel:", err)
		return
	}
	if err == nil {
		if parsed, perr := platform.ParseJSON([]byte(cached)); perr == nil {
			platform.JSON(w, 200, parsed)
			return
		}
		fail(w, "Erreur récupération appel:", errors.New("cache illisible"))
		return
	}

	participants, err := h.db.Rows(ctx, "SELECT user_id FROM call_participants WHERE call_id = ? AND left_at IS NULL", callID)
	if err != nil {
		fail(w, "Erreur récupération appel:", err)
		return
	}
	ids := make([]any, len(participants))
	for i, p := range participants {
		ids[i] = p.Get("user_id")
	}
	tier := call.Get("current_quality_tier")
	if !platform.Truthy(tier) {
		tier = 0
	}
	platform.JSON(w, 200, platform.O(
		"id", call.Get("id"),
		"type", call.Get("type"),
		"callCategory", call.Get("call_category"),
		"initiatorId", call.Get("initiator_id"),
		"channelId", call.Get("channel_id"),
		"conversationId", call.Get("conversation_id"),
		"serverId", call.Get("server_id"),
		"status", call.Get("status"),
		"currentQualityTier", tier,
		"startedAt", call.Get("started_at"),
		"endedAt", call.Get("ended_at"),
		"participants", ids,
	))
}

// GET /calls/:callId/quality — tier courant + nombre de participants (gateway).
func (h *handlers) getQuality(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	callID, userID := r.PathValue("callId"), platform.UserID(r)
	call, err := h.loadCall(ctx, callID)
	if err != nil {
		fail(w, "Erreur récupération qualité:", err)
		return
	}
	if call == nil {
		platform.Error(w, 404, "Appel non trouvé")
		return
	}
	if userID != "" {
		ok, err := h.canAccessCall(ctx, userID, call)
		if err != nil {
			fail(w, "Erreur récupération qualité:", err)
			return
		}
		if !ok {
			platform.Error(w, 403, "Accès non autorisé")
			return
		}
	}
	count, err := h.countActive(ctx, callID)
	if err != nil {
		fail(w, "Erreur récupération qualité:", err)
		return
	}
	platform.JSON(w, 200, platform.O(
		"callId", callID,
		"tier", call.Get("current_quality_tier"),
		"participantCount", count,
		"callCategory", call.Get("call_category"),
	))
}

// ── Création ──────────────────────────────────────────────────────────────

func nowISO() string { return platform.JSDate(platform.Now()) }

func (h *handlers) insertCall(ctx context.Context, query string, args []any, callID, initiator string, data *platform.Object) error {
	if _, err := h.db.Exec(ctx, query, args...); err != nil {
		return err
	}
	if _, err := h.db.Exec(ctx, "INSERT INTO call_participants (call_id, user_id) VALUES (?, ?)", callID, initiator); err != nil {
		return err
	}
	return h.store(ctx, callID, data)
}

// createDM sert POST /calls/dm et POST /calls (compatibilité ancien client).
func (h *handlers) createDM(okLog, errLog string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		body := platform.Body(r)
		typ, conversationID := body.Get("type"), body.Get("conversationId")
		initiatorID := platform.UserID(r)

		if initiatorID == "" {
			platform.Error(w, 401, "Authentification requise")
			return
		}
		if !platform.StrictEqual(typ, "voice") && !platform.StrictEqual(typ, "video") {
			platform.Error(w, 400, "type doit être 'voice' ou 'video'")
			return
		}
		member, err := h.isConversationMember(ctx, initiatorID, conversationID)
		if err != nil {
			fail(w, errLog, err)
			return
		}
		if !member {
			platform.Error(w, 403, "Accès non autorisé à cette conversation")
			return
		}

		callID := uuid.NewString()
		convOut := platform.Or(conversationID, nil)
		data := platform.O(
			"id", callID, "type", typ, "callCategory", "dm", "initiatorId", initiatorID,
			"conversationId", convOut,
			"status", "ringing", "participants", []any{initiatorID},
			"startedAt", nowISO(),
		)
		if err := h.insertCall(ctx,
			`INSERT INTO calls (id, type, call_category, initiator_id, conversation_id, status)
       VALUES (?, ?, 'dm', ?, ?, 'ringing')`,
			[]any{callID, platform.SQLParam(typ), initiatorID, platform.SQLParam(conversationID)}, callID, initiatorID, data); err != nil {
			fail(w, errLog, err)
			return
		}
		slog.Info(okLog + callID)
		platform.JSON(w, 201, data)
	}
}

// POST /calls/group — appel groupe (≤100, P2P puis SFU).
func (h *handlers) createGroup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	body := platform.Body(r)
	channelID, typ := body.Get("channelId"), body.Get("type")
	initiatorID := platform.UserID(r)

	if !platform.Truthy(channelID) || initiatorID == "" {
		platform.Error(w, 400, "channelId requis et authentification nécessaire")
		return
	}
	member, err := h.isConversationMember(ctx, initiatorID, channelID)
	if err != nil {
		fail(w, "Erreur création appel groupe:", err)
		return
	}
	if !member {
		platform.Error(w, 403, "Accès non autorisé à ce groupe")
		return
	}

	callID := uuid.NewString()
	typeOut := platform.Or(typ, "voice")
	data := platform.O(
		"id", callID, "type", typeOut, "callCategory", "group",
		"channelId", channelID, "status", "ringing", "initiatorId", initiatorID,
		"participants", []any{initiatorID}, "startedAt", nowISO(),
	)
	if err := h.insertCall(ctx,
		`INSERT INTO calls (id, type, call_category, initiator_id, channel_id, status)
       VALUES (?, ?, 'group', ?, ?, 'ringing')`,
		[]any{callID, platform.SQLParam(typeOut), initiatorID, platform.SQLParam(channelID)}, callID, initiatorID, data); err != nil {
		fail(w, "Erreur création appel groupe:", err)
		return
	}
	slog.Info("Appel groupe créé: " + callID)
	platform.JSON(w, 201, data)
}

// POST /calls/server — appel serveur / communauté (≤1500, SFU).
func (h *handlers) createServer(w http.ResponseWriter, r *http.Request) {
	const errLog = "Erreur création appel serveur:"
	ctx := r.Context()
	body := platform.Body(r)
	channelID, serverID, typ := body.Get("channelId"), body.Get("serverId"), body.Get("type")
	initiatorID := platform.UserID(r)

	if !platform.Truthy(channelID) || !platform.Truthy(serverID) || initiatorID == "" {
		platform.Error(w, 400, "channelId et serverId requis")
		return
	}
	member, err := h.isServerMember(ctx, initiatorID, serverID)
	if err != nil {
		fail(w, errLog, err)
		return
	}
	if !member {
		platform.Error(w, 403, "Vous n'êtes pas membre de ce serveur")
		return
	}
	// Le salon doit appartenir au serveur quand il est connu en base (les
	// serveurs auto-hébergés gardent leurs salons sur leur node).
	chans, err := h.db.Rows(ctx, "SELECT server_id FROM channels WHERE id = ?", platform.SQLParam(channelID))
	if err != nil {
		fail(w, errLog, err)
		return
	}
	if len(chans) > 0 && !platform.StrictEqual(chans[0].Get("server_id"), serverID) {
		platform.Error(w, 403, "Ce salon n'appartient pas à ce serveur")
		return
	}

	existing, err := h.db.Rows(ctx,
		"SELECT id FROM calls WHERE channel_id = ? AND call_category = 'server' AND status IN ('ringing','ongoing')",
		platform.SQLParam(channelID))
	if err != nil {
		fail(w, errLog, err)
		return
	}
	if len(existing) > 0 {
		platform.JSON(w, 409, platform.O("error", "Un appel est déjà actif sur ce canal", "existingCallId", existing[0].Get("id")))
		return
	}

	callID := uuid.NewString()
	typeOut := platform.Or(typ, "voice")
	data := platform.O(
		"id", callID, "type", typeOut, "callCategory", "server",
		"channelId", channelID, "serverId", serverID, "status", "ongoing", "initiatorId", initiatorID,
		"currentQualityTier", 0, "participants", []any{initiatorID},
		"startedAt", nowISO(),
	)
	if err := h.insertCall(ctx,
		`INSERT INTO calls (id, type, call_category, initiator_id, channel_id, server_id, status)
       VALUES (?, ?, 'server', ?, ?, ?, 'ongoing')`,
		[]any{callID, platform.SQLParam(typeOut), initiatorID, platform.SQLParam(channelID), platform.SQLParam(serverID)}, callID, initiatorID, data); err != nil {
		fail(w, errLog, err)
		return
	}
	slog.Info("Appel serveur créé: " + callID)
	platform.JSON(w, 201, data)
}

// ── Qualité (interne) ─────────────────────────────────────────────────────

// POST /calls/:callId/quality — appelé par le media-server.
func (h *handlers) setQuality(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	callID := r.PathValue("callId")
	body := platform.Body(r)
	tier := platform.GetPath(body, "tier")
	reason, participantCount := body.Get("reason"), body.Get("participantCount")

	if tier == platform.Undefined {
		platform.Error(w, 400, "tier doit être entre 0 et 3")
		return
	}
	if n := platform.ToNumber(tier); n < 0 || n > 3 {
		platform.Error(w, 400, "tier doit être entre 0 et 3")
		return
	}

	if _, err := h.db.Exec(ctx, "UPDATE calls SET current_quality_tier = ? WHERE id = ?", platform.SQLParam(tier), callID); err != nil {
		fail(w, "Erreur mise à jour qualité:", err)
		return
	}
	if _, err := h.db.Exec(ctx,
		`INSERT INTO call_quality_events (call_id, tier, reason, participant_count)
       VALUES (?, ?, ?, ?)`,
		callID, platform.SQLParam(tier),
		platform.SQLParam(platform.Or(reason, "participant_count")),
		platform.SQLParam(platform.Or(participantCount, 0))); err != nil {
		fail(w, "Erreur mise à jour qualité:", err)
		return
	}
	if err := h.forget(ctx, callID); err != nil {
		fail(w, "Erreur mise à jour qualité:", err)
		return
	}
	slog.Info("Tier qualité mis à jour: " + callID)
	platform.JSON(w, 200, platform.O("success", true))
}

// ── Participation ─────────────────────────────────────────────────────────

// POST /calls/:callId/join
func (h *handlers) join(w http.ResponseWriter, r *http.Request) {
	const errLog = "Erreur rejoindre appel:"
	ctx := r.Context()
	callID, userID := r.PathValue("callId"), platform.UserID(r)
	if userID == "" {
		platform.Error(w, 401, "Authentification requise")
		return
	}
	call, err := h.db.First(ctx, "SELECT * FROM calls WHERE id = ? AND status IN ('ringing', 'ongoing')", callID)
	if err != nil {
		fail(w, errLog, err)
		return
	}
	if call == nil {
		platform.Error(w, 404, "Appel non trouvé ou terminé")
		return
	}
	category := call.Str("call_category")
	ok, err := h.canAccessCall(ctx, userID, call)
	if err != nil {
		fail(w, errLog, err)
		return
	}
	if !ok {
		platform.Error(w, 403, "Accès non autorisé à cet appel")
		return
	}

	current, err := h.countActive(ctx, callID)
	if err != nil {
		fail(w, errLog, err)
		return
	}
	maxAllowed, err := h.participantLimit(ctx, category, call.Get("server_id"))
	if err != nil {
		fail(w, errLog, err)
		return
	}
	if category == "dm" && current >= 2 {
		platform.JSON(w, 403, platform.O("error", "CALL_FULL", "maxParticipants", 2))
		return
	}
	if current >= maxAllowed {
		platform.JSON(w, 403, platform.O("error", "CALL_FULL", "maxParticipants", maxAllowed))
		return
	}

	if _, err := h.db.Exec(ctx, "INSERT IGNORE INTO call_participants (call_id, user_id) VALUES (?, ?)", callID, userID); err != nil {
		fail(w, errLog, err)
		return
	}
	if _, err := h.db.Exec(ctx, "UPDATE calls SET status = 'ongoing' WHERE id = ? AND status = 'ringing'", callID); err != nil {
		fail(w, errLog, err)
		return
	}
	if err := h.forget(ctx, callID); err != nil {
		fail(w, errLog, err)
		return
	}
	slog.Info(userID + " a rejoint l'appel " + callID + " (" + category + ")")
	platform.JSON(w, 200, platform.O("success", true, "callCategory", category))
}

// POST /calls/:callId/reject — refuser un appel DM.
func (h *handlers) reject(w http.ResponseWriter, r *http.Request) {
	const errLog = "Erreur refus appel:"
	ctx := r.Context()
	callID, userID := r.PathValue("callId"), platform.UserID(r)
	if userID == "" {
		platform.Error(w, 401, "Authentification requise")
		return
	}
	// Seul un destinataire légitime peut refuser.
	call, err := h.loadCall(ctx, callID)
	if err != nil {
		fail(w, errLog, err)
		return
	}
	if call == nil {
		platform.Error(w, 404, "Appel non trouvé")
		return
	}
	if call.Str("initiator_id") == userID {
		platform.Error(w, 403, "Accès non autorisé")
		return
	}
	ok, err := h.canAccessCall(ctx, userID, call)
	if err != nil {
		fail(w, errLog, err)
		return
	}
	if !ok {
		platform.Error(w, 403, "Accès non autorisé")
		return
	}

	active, err := h.db.Rows(ctx, "SELECT user_id FROM call_participants WHERE call_id = ? AND user_id != ? AND left_at IS NULL", callID, userID)
	if err != nil {
		fail(w, errLog, err)
		return
	}
	if len(active) <= 1 {
		if _, err := h.db.Exec(ctx, "UPDATE calls SET status = 'missed', ended_at = NOW() WHERE id = ?", callID); err != nil {
			fail(w, errLog, err)
			return
		}
		if err := h.forget(ctx, callID); err != nil {
			fail(w, errLog, err)
			return
		}
	}
	slog.Info(userID + " a refusé l'appel " + callID)
	platform.JSON(w, 200, platform.O("success", true))
}

// POST /calls/:callId/leave — quitter sans terminer pour les autres.
func (h *handlers) leave(w http.ResponseWriter, r *http.Request) {
	const errLog = "Erreur quitter appel:"
	ctx := r.Context()
	callID, userID := r.PathValue("callId"), platform.UserID(r)
	if userID == "" {
		platform.Error(w, 401, "Authentification requise")
		return
	}
	if _, err := h.db.Exec(ctx, "UPDATE call_participants SET left_at = NOW() WHERE call_id = ? AND user_id = ? AND left_at IS NULL", callID, userID); err != nil {
		fail(w, errLog, err)
		return
	}
	remaining, err := h.countActive(ctx, callID)
	if err != nil {
		fail(w, errLog, err)
		return
	}
	if remaining == 0 {
		if _, err := h.db.Exec(ctx, "UPDATE calls SET status = 'ended', ended_at = NOW() WHERE id = ?", callID); err != nil {
			fail(w, errLog, err)
			return
		}
	}
	if err := h.forget(ctx, callID); err != nil {
		fail(w, errLog, err)
		return
	}
	slog.Info(userID + " a quitté l'appel " + callID)
	platform.JSON(w, 200, platform.O("success", true, "remainingParticipants", remaining))
}

// POST /calls/:callId/end — terminer pour tous.
func (h *handlers) end(w http.ResponseWriter, r *http.Request) {
	const errLog = "Erreur fin appel:"
	ctx := r.Context()
	callID, userID := r.PathValue("callId"), platform.UserID(r)
	if userID == "" {
		platform.Error(w, 401, "Authentification requise")
		return
	}
	// Participant ENCORE présent (ou initiateur) : un ancien participant ne
	// doit pas couper l'appel des autres après l'avoir quitté.
	rows, err := h.db.Rows(ctx,
		`SELECT 1 FROM call_participants cp
       JOIN calls c ON c.id = cp.call_id
       WHERE cp.call_id = ? AND cp.user_id = ? AND (cp.left_at IS NULL OR c.initiator_id = ?)`,
		callID, userID, userID)
	if err != nil {
		fail(w, errLog, err)
		return
	}
	if len(rows) == 0 {
		platform.Error(w, 403, "Non autorisé à terminer cet appel")
		return
	}
	if _, err := h.db.Exec(ctx, "UPDATE calls SET status = 'ended', ended_at = NOW() WHERE id = ?", callID); err != nil {
		fail(w, errLog, err)
		return
	}
	if _, err := h.db.Exec(ctx, "UPDATE call_participants SET left_at = NOW() WHERE call_id = ? AND left_at IS NULL", callID); err != nil {
		fail(w, errLog, err)
		return
	}
	if err := h.forget(ctx, callID); err != nil {
		fail(w, errLog, err)
		return
	}
	slog.Info("Appel " + callID + " terminé par " + userID)
	platform.JSON(w, 200, platform.O("success", true))
}
