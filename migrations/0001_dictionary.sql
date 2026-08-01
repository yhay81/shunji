CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  headword TEXT NOT NULL,
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 9),
  payload TEXT NOT NULL
);

CREATE TABLE terms (
  term TEXT NOT NULL,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 9),
  kind INTEGER NOT NULL CHECK(kind IN (0, 1)),
  PRIMARY KEY(term, entry_id)
) WITHOUT ROWID;

CREATE INDEX terms_entry_idx ON terms(entry_id);
CREATE INDEX entries_score_idx ON entries(score, id);

CREATE VIRTUAL TABLE entry_fts USING fts5(
  glosses,
  content='',
  detail=full,
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TABLE dictionary_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE product_events (
  session_hash TEXT NOT NULL,
  event_name TEXT NOT NULL CHECK(event_name IN ('visited', 'searched', 'no_result', 'entry_opened', 'saved', 'copied', 'returned')),
  entry_id INTEGER NOT NULL DEFAULT 0,
  is_qa INTEGER NOT NULL DEFAULT 0 CHECK(is_qa IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_hash, event_name, entry_id, created_at)
) WITHOUT ROWID;

CREATE INDEX product_events_created_idx ON product_events(created_at);
CREATE INDEX product_events_event_idx ON product_events(event_name, is_qa, created_at);
