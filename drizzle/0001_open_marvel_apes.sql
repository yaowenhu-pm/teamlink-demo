CREATE TABLE `operation_receipts` (
	`room_id` text NOT NULL,
	`nonce` text NOT NULL,
	`request_hash` text NOT NULL,
	`message_json` text NOT NULL,
	`kind` text NOT NULL,
	`revision` integer,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`room_id`, `nonce`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `operation_receipts_expiry_idx` ON `operation_receipts` (`expires_at`);
--> statement-breakpoint
-- Existing messages have no per-message revision. Preserve their nonces without
-- inventing a historical revision; missing legacy fingerprints fail closed.
INSERT INTO operation_receipts (room_id, nonce, request_hash, message_json, kind, revision, expires_at)
SELECT rooms.id, json_extract(message.value, '$.nonce'),
  COALESCE(json_extract(message.value, '$._requestHash'), 'legacy-unavailable'),
  json(message.value), COALESCE(json_extract(message.value, '$.kind'), 'unknown'), NULL, rooms.expires_at
FROM rooms, json_each(rooms.messages_json) AS message
WHERE message.key < 64 AND message.type = 'object'
  AND typeof(json_extract(message.value, '$.nonce')) = 'text'
ON CONFLICT(room_id, nonce) DO NOTHING;
--> statement-breakpoint
-- A receipt is immutable after pending has become a terminal result. A trigger
-- failure aborts the enclosing room CAS, so no applied operation lacks a receipt.
CREATE TRIGGER operation_receipts_guard_update BEFORE UPDATE ON operation_receipts
BEGIN
  SELECT RAISE(ABORT, 'operation receipt is immutable')
  WHERE OLD.room_id IS NOT NEW.room_id OR OLD.nonce IS NOT NEW.nonce
    OR OLD.request_hash IS NOT NEW.request_hash OR OLD.expires_at IS NOT NEW.expires_at
    OR ((OLD.kind <> 'pending' OR NEW.kind = 'pending') AND
      (OLD.kind IS NOT NEW.kind OR json(OLD.message_json) IS NOT json(NEW.message_json)
        OR OLD.revision IS NOT NEW.revision));
END;
--> statement-breakpoint
CREATE TRIGGER rooms_receipts_insert AFTER INSERT ON rooms
BEGIN
  INSERT INTO operation_receipts (room_id, nonce, request_hash, message_json, kind, revision, expires_at)
  SELECT NEW.id, json_extract(message.value, '$.nonce'),
    COALESCE(json_extract(message.value, '$._requestHash'), 'legacy-unavailable'),
    json(message.value), COALESCE(json_extract(message.value, '$.kind'), 'unknown'), NEW.revision, NEW.expires_at
  FROM json_each(NEW.messages_json) AS message
  WHERE message.key < 64 AND message.type = 'object'
    AND typeof(json_extract(message.value, '$.nonce')) = 'text'
  ON CONFLICT(room_id, nonce) DO UPDATE SET request_hash = excluded.request_hash,
    message_json = excluded.message_json, kind = excluded.kind, revision = excluded.revision
  WHERE operation_receipts.request_hash IS NOT excluded.request_hash
    OR json(operation_receipts.message_json) IS NOT json(excluded.message_json);
END;
--> statement-breakpoint
CREATE TRIGGER rooms_receipts_update AFTER UPDATE OF messages_json ON rooms
BEGIN
  INSERT INTO operation_receipts (room_id, nonce, request_hash, message_json, kind, revision, expires_at)
  SELECT NEW.id, json_extract(message.value, '$.nonce'),
    COALESCE(json_extract(message.value, '$._requestHash'), 'legacy-unavailable'),
    json(message.value), COALESCE(json_extract(message.value, '$.kind'), 'unknown'), NEW.revision, NEW.expires_at
  FROM json_each(NEW.messages_json) AS message
  WHERE message.key < 64 AND message.type = 'object'
    AND typeof(json_extract(message.value, '$.nonce')) = 'text'
  ON CONFLICT(room_id, nonce) DO UPDATE SET request_hash = excluded.request_hash,
    message_json = excluded.message_json, kind = excluded.kind, revision = excluded.revision
  WHERE operation_receipts.request_hash IS NOT excluded.request_hash
    OR json(operation_receipts.message_json) IS NOT json(excluded.message_json);
END;
--> statement-breakpoint
-- Keep cleanup reliable even for a compatible adapter without foreign_keys=ON.
CREATE TRIGGER rooms_receipts_delete AFTER DELETE ON rooms
BEGIN
  DELETE FROM operation_receipts WHERE room_id = OLD.id;
END;
