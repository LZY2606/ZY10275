-- 审阅台分析结果持久化。packet 不存原始字节，只存解析视图。
CREATE TABLE IF NOT EXISTS analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  frame_size INTEGER NOT NULL,
  frame_reason TEXT NOT NULL,
  packet_count INTEGER NOT NULL,
  input_bytes INTEGER NOT NULL,
  skipped_leader INTEGER NOT NULL,
  trailing INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS packets (
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  arrival_index INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  pusi INTEGER NOT NULL,
  tei INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  scrambling INTEGER NOT NULL,
  afc INTEGER NOT NULL,
  cc INTEGER NOT NULL,
  has_payload INTEGER NOT NULL,
  payload_offset INTEGER,
  payload_length INTEGER,
  af_length INTEGER,
  di INTEGER NOT NULL DEFAULT 0,
  rai INTEGER NOT NULL DEFAULT 0,
  pcr TEXT,
  opcr TEXT,
  stuffing_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, arrival_index)
);
CREATE INDEX IF NOT EXISTS idx_packets_pid ON packets(run_id, pid, arrival_index);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  pid INTEGER NOT NULL,
  table_id INTEGER NOT NULL,
  table_id_extension INTEGER NOT NULL,
  version INTEGER NOT NULL,
  current_next INTEGER NOT NULL,
  section_number INTEGER NOT NULL,
  last_section_number INTEGER NOT NULL,
  section_length INTEGER NOT NULL,
  total_length INTEGER NOT NULL,
  crc_valid INTEGER NOT NULL,
  crc_expected INTEGER NOT NULL,
  crc_actual INTEGER NOT NULL,
  start_packet INTEGER NOT NULL,
  end_packet INTEGER NOT NULL,
  carried_packets TEXT NOT NULL,
  pointer_field INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sections_run ON sections(run_id, start_packet);

CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pat', 'pmt')),
  gen_seq INTEGER NOT NULL,
  program_number INTEGER,
  version INTEGER NOT NULL,
  rolled_back INTEGER NOT NULL,
  start_packet INTEGER NOT NULL,
  end_packet INTEGER,
  pcr_pid INTEGER,
  body_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generations_lookup ON generations(run_id, kind, program_number, start_packet);

CREATE TABLE IF NOT EXISTS timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  packet_index INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_pid ON timeline_events(run_id, pid, packet_index);
CREATE INDEX IF NOT EXISTS idx_events_packet ON timeline_events(run_id, packet_index);

CREATE TABLE IF NOT EXISTS pes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  packet_index INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  stream_id INTEGER NOT NULL,
  length INTEGER NOT NULL,
  pts INTEGER,
  dts INTEGER,
  scrambled INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pcr_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  packet_index INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pcr', 'opcr')),
  program_number INTEGER,
  raw TEXT NOT NULL,
  base TEXT NOT NULL,
  extension INTEGER NOT NULL,
  unwrapped TEXT NOT NULL,
  delta TEXT,
  discontinuity INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pcr_pid ON pcr_timeline(run_id, pid, packet_index);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
