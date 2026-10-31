import {integer, text, sqliteTable, index, primaryKey} from 'drizzle-orm/sqlite-core';

export const rooms = sqliteTable('rooms', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull(),
  revision: integer('revision').notNull().default(0),
  sceneJson: text('scene_json').notNull(),
  messagesJson: text('messages_json').notNull().default('[]'),
  historyJson: text('history_json').notNull().default('[]'),
  expiresAt: integer('expires_at').notNull(),
  nextMessageAt: integer('next_message_at').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  creatorIpHash: text('creator_ip_hash').notNull(),
  aiCalls: integer('ai_calls').notNull().default(0),
  busyNonce: text('busy_nonce'),
  busyUntil: integer('busy_until').notNull().default(0),
}, table => [
  index('rooms_expiry_idx').on(table.expiresAt),
  index('rooms_creator_hour_idx').on(table.creatorIpHash, table.createdAt),
]);

export const aiUsage = sqliteTable('ai_usage', {
  day: text('day').primaryKey(),
  calls: integer('calls').notNull().default(0),
});

// Receipts survive the rolling message window for the entire room lifetime.
export const operationReceipts = sqliteTable('operation_receipts', {
  roomId: text('room_id').notNull().references(() => rooms.id, {onDelete: 'cascade'}),
  nonce: text('nonce').notNull(),
  requestHash: text('request_hash').notNull(),
  messageJson: text('message_json').notNull(),
  kind: text('kind').notNull(),
  revision: integer('revision'),
  expiresAt: integer('expires_at').notNull(),
}, table => [
  primaryKey({columns: [table.roomId, table.nonce]}),
  index('operation_receipts_expiry_idx').on(table.expiresAt),
]);
