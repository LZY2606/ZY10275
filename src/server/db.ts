import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AnalysisResult, StateSnapshot } from '../core/types'
import { stateAt } from '../core/analyzer'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  )
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue
    db.exec('BEGIN')
    try {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  migrate(db)
  return db
}

export function saveAnalysis(db: DatabaseSync, name: string, r: AnalysisResult): number {
  db.exec('BEGIN')
  try {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO streams (name, packet_size, packet_count) VALUES (?, ?, ?)')
      .run(name, r.packetSize, r.packetCount)
    const id = Number(lastInsertRowid)
    const insPacket = db.prepare(
      'INSERT INTO packets (stream_id, idx, pid, pusi, tei, afc, cc, has_payload, discontinuity, has_pcr, has_opcr) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
    for (const p of r.packets) {
      insPacket.run(id, p.idx, p.pid, +p.pusi, +p.tei, p.afc, p.cc, +p.hasPayload, +p.discontinuity, +p.hasPcr, +p.hasOpcr)
    }
    const insSection = db.prepare(
      'INSERT INTO sections (stream_id, pid, table_id, version, current_next, section_number, start_idx, end_idx, crc_ok, error) VALUES (?,?,?,?,?,?,?,?,?,?)',
    )
    for (const s of r.sections) {
      insSection.run(id, s.pid, s.tableId, s.version, +s.currentNext, s.sectionNumber, s.startIdx, s.endIdx, +s.crcOk, s.error ?? null)
    }
    const insPat = db.prepare(
      'INSERT INTO pat_generations (stream_id, gen, start_idx, version, programs_json) VALUES (?,?,?,?,?)',
    )
    for (const g of r.patGenerations) insPat.run(id, g.gen, g.startIdx, g.version, JSON.stringify(g.programs))
    const insPmt = db.prepare(
      'INSERT INTO pmt_generations (stream_id, pid, gen, program, start_idx, version, pcr_pid, streams_json) VALUES (?,?,?,?,?,?,?,?)',
    )
    for (const g of r.pmtGenerations) {
      insPmt.run(id, g.pid, g.gen, g.program, g.startIdx, g.version, g.pcrPid, JSON.stringify(g.streams))
    }
    const insEvent = db.prepare('INSERT INTO events (stream_id, idx, pid, kind, detail_json) VALUES (?,?,?,?,?)')
    for (const e of r.events) insEvent.run(id, e.idx, e.pid, e.kind, JSON.stringify(e.detail))
    const insPcr = db.prepare(
      'INSERT INTO pcr_samples (stream_id, idx, pid, raw27, unwrapped27, wraps, program, pmt_gen) VALUES (?,?,?,?,?,?,?,?)',
    )
    for (const s of r.pcrSamples) {
      insPcr.run(id, s.idx, s.pid, s.raw27, s.unwrapped27, s.wraps, s.program, s.pmtGen)
    }
    db.exec('COMMIT')
    return id
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function loadAnalysis(db: DatabaseSync, streamId: number): AnalysisResult {
  const packets = db.prepare('SELECT * FROM packets WHERE stream_id = ? ORDER BY idx').all(streamId) as any[]
  const sections = db.prepare('SELECT * FROM sections WHERE stream_id = ? ORDER BY end_idx').all(streamId) as any[]
  const patGens = db.prepare('SELECT * FROM pat_generations WHERE stream_id = ? ORDER BY gen').all(streamId) as any[]
  const pmtGens = db.prepare('SELECT * FROM pmt_generations WHERE stream_id = ? ORDER BY pid, gen').all(streamId) as any[]
  const events = db.prepare('SELECT * FROM events WHERE stream_id = ? ORDER BY idx').all(streamId) as any[]
  const pcr = db.prepare('SELECT * FROM pcr_samples WHERE stream_id = ? ORDER BY idx').all(streamId) as any[]
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId) as any
  if (!stream) throw new Error(`stream ${streamId} not found`)
  return {
    packetSize: stream.packet_size,
    packetCount: stream.packet_count,
    packets: packets.map((p) => ({
      idx: p.idx, pid: p.pid, pusi: !!p.pusi, tei: !!p.tei, afc: p.afc, cc: p.cc,
      hasPayload: !!p.has_payload, discontinuity: !!p.discontinuity, hasPcr: !!p.has_pcr, hasOpcr: !!p.has_opcr,
    })),
    sections: sections.map((s) => ({
      pid: s.pid, tableId: s.table_id, version: s.version, currentNext: !!s.current_next,
      sectionNumber: s.section_number, startIdx: s.start_idx, endIdx: s.end_idx,
      crcOk: !!s.crc_ok, error: s.error ?? undefined,
    })),
    patGenerations: patGens.map((g) => ({
      gen: g.gen, startIdx: g.start_idx, version: g.version, programs: JSON.parse(g.programs_json),
    })),
    pmtGenerations: pmtGens.map((g) => ({
      gen: g.gen, pid: g.pid, program: g.program, startIdx: g.start_idx, version: g.version,
      pcrPid: g.pcr_pid, streams: JSON.parse(g.streams_json),
    })),
    events: events.map((e) => ({ idx: e.idx, pid: e.pid, kind: e.kind, detail: JSON.parse(e.detail_json) })),
    pcrSamples: pcr.map((s) => ({
      idx: s.idx, pid: s.pid, raw27: s.raw27, unwrapped27: s.unwrapped27, wraps: s.wraps,
      program: s.program, pmtGen: s.pmt_gen,
    })),
  }
}

export function loadStateAt(db: DatabaseSync, streamId: number, idx: number): StateSnapshot {
  return stateAt(loadAnalysis(db, streamId), idx)
}
