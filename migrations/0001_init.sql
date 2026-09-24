CREATE TABLE streams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  packet_size INTEGER NOT NULL,
  packet_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE packets (
  stream_id INTEGER NOT NULL REFERENCES streams(id),
  idx INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  pusi INTEGER NOT NULL,
  tei INTEGER NOT NULL,
  afc INTEGER NOT NULL,
  cc INTEGER NOT NULL,
  has_payload INTEGER NOT NULL,
  discontinuity INTEGER NOT NULL,
  has_pcr INTEGER NOT NULL,
  has_opcr INTEGER NOT NULL,
  PRIMARY KEY (stream_id, idx)
);
CREATE INDEX idx_packets_pid ON packets(stream_id, pid);

CREATE TABLE sections (
  stream_id INTEGER NOT NULL REFERENCES streams(id),
  pid INTEGER NOT NULL,
  table_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  current_next INTEGER NOT NULL,
  section_number INTEGER NOT NULL,
  start_idx INTEGER NOT NULL,
  end_idx INTEGER NOT NULL,
  crc_ok INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX idx_sections_stream ON sections(stream_id, end_idx);

CREATE TABLE pat_generations (
  stream_id INTEGER NOT NULL REFERENCES streams(id),
  gen INTEGER NOT NULL,
  start_idx INTEGER NOT NULL,
  version INTEGER NOT NULL,
  programs_json TEXT NOT NULL,
  PRIMARY KEY (stream_id, gen)
);

CREATE TABLE pmt_generations (
  stream_id INTEGER NOT NULL REFERENCES streams(id),
  pid INTEGER NOT NULL,
  gen INTEGER NOT NULL,
  program INTEGER NOT NULL,
  start_idx INTEGER NOT NULL,
  version INTEGER NOT NULL,
  pcr_pid INTEGER NOT NULL,
  streams_json TEXT NOT NULL,
  PRIMARY KEY (stream_id, pid, gen)
);

CREATE TABLE events (
  stream_id INTEGER NOT NULL REFERENCES streams(id),
  idx INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX idx_events_stream ON events(stream_id, idx);

CREATE TABLE pcr_samples (
  stream_id INTEGER NOT NULL REFERENCES streams(id),
  idx INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  raw27 REAL NOT NULL,
  unwrapped27 REAL NOT NULL,
  wraps INTEGER NOT NULL,
  program INTEGER,
  pmt_gen INTEGER
);
CREATE INDEX idx_pcr_stream ON pcr_samples(stream_id, idx);
