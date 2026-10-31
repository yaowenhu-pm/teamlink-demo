import {integer, text, sqliteTable, index} from 'drizzle-orm/sqlite-core';

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
