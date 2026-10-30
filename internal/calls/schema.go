// ==========================================
// ALFYCHAT - SCHÉMA DU SERVICE CALLS
// ==========================================

package calls

import (
	"context"

	"github.com/alfychat/calls/internal/platform"
)

var tables = []string{
	`CREATE TABLE IF NOT EXISTS calls (
        id VARCHAR(36) PRIMARY KEY,
        type ENUM('voice', 'video') NOT NULL,
        call_category ENUM('dm', 'group', 'server') NOT NULL DEFAULT 'dm',
        initiator_id VARCHAR(36) NOT NULL,
        channel_id VARCHAR(36) NULL DEFAULT NULL,
        conversation_id VARCHAR(100) NULL DEFAULT NULL,
        server_id VARCHAR(36) NULL DEFAULT NULL,
        status ENUM('ringing', 'ongoing', 'ended', 'missed') DEFAULT 'ringing',
        current_quality_tier TINYINT UNSIGNED NOT NULL DEFAULT 0,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP NULL DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS call_participants (
        call_id VARCHAR(36) NOT NULL,
        user_id VARCHAR(36) NOT NULL,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        left_at TIMESTAMP NULL DEFAULT NULL,
        is_muted BOOLEAN DEFAULT FALSE,
        is_video_enabled BOOLEAN DEFAULT FALSE,
        is_screen_sharing BOOLEAN DEFAULT FALSE,
        PRIMARY KEY (call_id, user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS call_participant_limits (
        scope_type ENUM('dm', 'group', 'server') NOT NULL,
        scope_id VARCHAR(36) NOT NULL,
        max_participants INT UNSIGNED NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (scope_type, scope_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS call_quality_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        call_id VARCHAR(36) NOT NULL,
        tier TINYINT UNSIGNED NOT NULL,
        reason VARCHAR(50) NOT NULL DEFAULT 'participant_count',
        participant_count INT UNSIGNED NOT NULL DEFAULT 0,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_call (call_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	// Limites par défaut
	`INSERT IGNORE INTO call_participant_limits (scope_type, scope_id, max_participants) VALUES
        ('dm',     'global', 2),
        ('group',  'global', 100),
        ('server', 'global', 1500)`,
}

// Migrate crée les tables puis applique les migrations non destructives
// (MySQL 8.0 n'a pas de IF NOT EXISTS sur ADD COLUMN / ADD INDEX).
func Migrate(ctx context.Context, db *platform.DB) error {
	for _, q := range tables {
		if _, err := db.Exec(ctx, q); err != nil {
			return err
		}
	}

	addCol := func(table, column, definition string) error {
		rows, err := db.Rows(ctx,
			"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
			table, column)
		if err != nil || len(rows) > 0 {
			return err
		}
		_, err = db.Exec(ctx, "ALTER TABLE `"+table+"` ADD COLUMN `"+column+"` "+definition)
		return err
	}
	addIdx := func(table, name, definition string) error {
		rows, err := db.Rows(ctx,
			"SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
			table, name)
		if err != nil || len(rows) > 0 {
			return err
		}
		_, err = db.Exec(ctx, "ALTER TABLE `"+table+"` ADD INDEX `"+name+"` "+definition)
		return err
	}

	for _, c := range [][3]string{
		{"calls", "call_category", "ENUM('dm','group','server') NOT NULL DEFAULT 'dm'"},
		{"calls", "conversation_id", "VARCHAR(100) NULL DEFAULT NULL"},
		{"calls", "server_id", "VARCHAR(36) NULL DEFAULT NULL"},
		{"calls", "current_quality_tier", "TINYINT UNSIGNED NOT NULL DEFAULT 0"},
	} {
		if err := addCol(c[0], c[1], c[2]); err != nil {
			return err
		}
	}
	for _, i := range [][3]string{
		{"call_participants", "idx_user_id", "(user_id)"},
		{"call_participants", "idx_call_active", "(call_id, left_at)"},
		{"calls", "idx_status", "(status)"},
		{"calls", "idx_category", "(call_category)"},
		{"calls", "idx_channel_category", "(channel_id, call_category)"},
	} {
		if err := addIdx(i[0], i[1], i[2]); err != nil {
			return err
		}
	}
	return nil
}
