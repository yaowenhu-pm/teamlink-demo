CREATE TABLE `ai_usage` (
	`day` text PRIMARY KEY NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`scene_json` text NOT NULL,
	`messages_json` text DEFAULT '[]' NOT NULL,
	`history_json` text DEFAULT '[]' NOT NULL,
	`expires_at` integer NOT NULL,
	`next_message_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`creator_ip_hash` text NOT NULL,
	`ai_calls` integer DEFAULT 0 NOT NULL,
	`busy_nonce` text,
	`busy_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rooms_expiry_idx` ON `rooms` (`expires_at`);--> statement-breakpoint
CREATE INDEX `rooms_creator_hour_idx` ON `rooms` (`creator_ip_hash`,`created_at`);