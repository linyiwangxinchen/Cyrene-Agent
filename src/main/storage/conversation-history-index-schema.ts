import type { ConversationDatabase } from "./conversation-database";

/** Only rebuildable derivative metadata uses this schema. FTS availability is checked on demand. */
export function migrateConversationHistoryIndex(database: ConversationDatabase): void {
  if (!database.db.prepare("SELECT version FROM schema_migrations WHERE version=11").get()) database.transaction(() => database.db.exec(`
    CREATE TABLE history_index_state(
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      -- 0 is current, 1 needs rebuilding, 2 was unreadable in the current worker.
      dirty INTEGER NOT NULL DEFAULT 1 CHECK(dirty IN (0,1,2)), withdrawn_key TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE history_index_docs(
      doc_id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      at INTEGER, kind TEXT NOT NULL
    );
    CREATE INDEX history_index_conversation ON history_index_docs(conversation_id);
    CREATE TABLE history_index_links(
      source_id TEXT NOT NULL, dependent_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      PRIMARY KEY(source_id,dependent_id)
    );
    CREATE INDEX history_index_dependent ON history_index_links(dependent_id);
    CREATE TABLE history_index_external(conversation_id TEXT PRIMARY KEY);
    CREATE TRIGGER history_index_entry_insert AFTER INSERT ON transcript_entries
      WHEN new.kind IN ('user','assistant','turn_rewind','turn_tombstone','presentation_patch','compaction_checkpoint','delivery_receipt','tool_started')
    BEGIN
      UPDATE history_index_state SET dirty=1 WHERE conversation_id IN (
        WITH RECURSIVE affected(id) AS (
          SELECT new.conversation_id UNION SELECT l.dependent_id FROM history_index_links l JOIN affected a ON a.id=l.source_id
        ) SELECT id FROM affected
      );
    END;
    CREATE TRIGGER history_index_record_change AFTER UPDATE OF record_json,deleted ON conversations
      WHEN new.deleted<>old.deleted
        OR json_extract(new.record_json,'$.title') IS NOT json_extract(old.record_json,'$.title')
        OR json_extract(new.record_json,'$.titleIsCustom') IS NOT json_extract(old.record_json,'$.titleIsCustom')
        OR json_extract(new.record_json,'$.mode') IS NOT json_extract(old.record_json,'$.mode')
        OR json_extract(new.record_json,'$.purpose') IS NOT json_extract(old.record_json,'$.purpose')
    BEGIN
      UPDATE history_index_state SET dirty=1 WHERE conversation_id IN (
        WITH RECURSIVE affected(id) AS (
          SELECT new.id UNION SELECT l.dependent_id FROM history_index_links l JOIN affected a ON a.id=l.source_id
        ) SELECT id FROM affected
      );
    END;
    CREATE TRIGGER history_index_run_status AFTER UPDATE OF status ON runs WHEN new.status<>old.status
    BEGIN UPDATE history_index_state SET dirty=1 WHERE conversation_id=new.conversation_id; END;
    INSERT INTO schema_migrations VALUES(11);
  `));
  if (!database.db.prepare("SELECT version FROM schema_migrations WHERE version=12").get()) {
    // The previous projection omitted settled user-only messages. Rebuild
    // derivative docs lazily while retaining the original transcript.
    database.transaction(() => database.db.exec(`
      CREATE TRIGGER history_index_pending_dispatch AFTER UPDATE OF record_json ON conversations
        WHEN json_extract(new.record_json,'$.pendingDispatch.messageId') IS NOT json_extract(old.record_json,'$.pendingDispatch.messageId')
      BEGIN UPDATE history_index_state SET dirty=1 WHERE conversation_id=new.id; END;
      UPDATE history_index_state SET dirty=1;
      INSERT INTO schema_migrations VALUES(12);
    `));
  } else database.db.exec("UPDATE history_index_state SET dirty=1 WHERE dirty=2");
}
