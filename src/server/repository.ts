/** 分析结果 <-> SQLite 的存取。 */

import type { DatabaseSync } from 'node:sqlite';
import type { AnalysisResult } from '../core/types.js';
import type { PcrTimelinePoint } from '../core/analyzer.js';

export interface RunSummary {
  id: number;
  name: string;
  frameSize: number;
  packetCount: number;
  createdAt: string;
}

export function saveAnalysis(
  db: DatabaseSync,
  name: string,
  result: AnalysisResult,
  pcrTimeline: PcrTimelinePoint[],
  frameReason: string,
  trailing: number,
): number {
  const run = db
    .prepare(
      `INSERT INTO analysis_runs(name, frame_size, frame_reason, packet_count, input_bytes, skipped_leader, trailing)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(name, result.frameSize, frameReason, result.packetCount, result.inputBytes, result.skippedLeader, trailing);
  const runId = Number(run.lastInsertRowid);

  const insPacket = db.prepare(
    `INSERT INTO packets(run_id, arrival_index, pid, pusi, tei, priority, scrambling, afc, cc,
       has_payload, payload_offset, payload_length, af_length, di, rai, pcr, opcr, stuffing_bytes)
     VALUES (@run_id,@arrival_index,@pid,@pusi,@tei,@priority,@scrambling,@afc,@cc,
       @has_payload,@payload_offset,@payload_length,@af_length,@di,@rai,@pcr,@opcr,@stuffing_bytes)`,
  );
  for (const p of result.packets) {
    insPacket.run({
      run_id: runId,
      arrival_index: p.arrivalIndex,
      pid: p.pid,
      pusi: p.payloadUnitStartIndicator ? 1 : 0,
      tei: p.tei ? 1 : 0,
      priority: p.priority ? 1 : 0,
      scrambling: p.scrambling,
      afc: p.adaptationFieldControl,
      cc: p.continuityCounter,
      has_payload: p.payload ? 1 : 0,
      payload_offset: p.payload?.offset ?? null,
      payload_length: p.payload?.length ?? null,
      af_length: p.adaptation?.length ?? null,
      di: p.adaptation?.discontinuityIndicator ? 1 : 0,
      rai: p.adaptation?.randomAccessIndicator ? 1 : 0,
      pcr: p.adaptation?.pcr ? p.adaptation.pcr.raw.toString() : null,
      opcr: p.adaptation?.opcr ? p.adaptation.opcr.raw.toString() : null,
      stuffing_bytes: p.adaptation?.stuffingBytes ?? 0,
    });
  }

  const insSection = db.prepare(
    `INSERT INTO sections(run_id, pid, table_id, table_id_extension, version, current_next,
       section_number, last_section_number, section_length, total_length, crc_valid,
       crc_expected, crc_actual, start_packet, end_packet, carried_packets, pointer_field)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const s of result.sections) {
    insSection.run(
      runId,
      s.pid,
      s.tableId,
      s.tableIdExtension,
      s.version,
      s.currentNextIndicator ? 1 : 0,
      s.sectionNumber,
      s.lastSectionNumber,
      s.sectionLength,
      s.totalLength,
      s.crcValid ? 1 : 0,
      s.crcExpected,
      s.crcActual,
      s.startPacket,
      s.endPacket,
      JSON.stringify(s.carriedPackets),
      s.pointerField,
    );
  }

  const insGen = db.prepare(
    `INSERT INTO generations(run_id, kind, gen_seq, program_number, version, rolled_back,
       start_packet, end_packet, pcr_pid, body_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  result.patGenerations.forEach((g, i) => {
    insGen.run(runId, 'pat', i, null, g.version, g.rolledBack ? 1 : 0, g.startPacket, g.endPacket, null, JSON.stringify(g));
  });
  result.pmtGenerations.forEach((g, i) => {
    insGen.run(
      runId,
      'pmt',
      i,
      g.programNumber,
      g.version,
      g.rolledBack ? 1 : 0,
      g.startPacket,
      g.endPacket,
      g.pcrPid,
      JSON.stringify(g),
    );
  });

  const insEvent = db.prepare(
    'INSERT INTO timeline_events(run_id, packet_index, pid, kind, message, detail_json) VALUES (?,?,?,?,?,?)',
  );
  for (const e of result.events) {
    insEvent.run(runId, e.packetIndex, e.pid, e.kind, e.message, JSON.stringify(e.detail));
  }

  const insPes = db.prepare(
    'INSERT INTO pes(run_id, packet_index, pid, stream_id, length, pts, dts, scrambled) VALUES (?,?,?,?,?,?,?,?)',
  );
  for (const p of result.pes) {
    insPes.run(runId, p.packetIndex, p.pid, p.streamId, p.length, p.pts, p.dts, p.scrambled ? 1 : 0);
  }

  const insPcr = db.prepare(
    `INSERT INTO pcr_timeline(run_id, packet_index, pid, kind, program_number, raw, base, extension,
       unwrapped, delta, discontinuity) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const c of pcrTimeline) {
    insPcr.run(
      runId,
      c.packetIndex,
      c.pid,
      c.kind,
      c.programNumber,
      c.raw,
      c.base,
      c.extension,
      c.unwrapped,
      c.deltaFromPrev,
      c.discontinuity ? 1 : 0,
    );
  }

  return runId;
}

export function listRuns(db: DatabaseSync): RunSummary[] {
  return (
    db
      .prepare(
        `SELECT id, name, frame_size AS frameSize, packet_count AS packetCount, created_at AS createdAt
         FROM analysis_runs ORDER BY id DESC`,
      )
      .all() as unknown as RunSummary[]
  );
}
