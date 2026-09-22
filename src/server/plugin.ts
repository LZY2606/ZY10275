/** Vite 开发服务器插件：提供审阅台 API。
 * 启动时分析内置 fixture（也接受上传的 .ts 字节），结果落 SQLite，浏览器取 JSON 审阅。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';
import { analyzeBuffer } from '../core/analyzer.js';
import { buildFixtureStream, encodeFrames } from '../core/fixture.js';
import { migrate, openDatabase } from './db.js';
import { listRuns, saveAnalysis } from './repository.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, '..', '..', '.data');
const DB_PATH = join(DATA_DIR, 'review-bench.sqlite');

interface PacketRow extends Record<string, number | string | null> {}
interface SectionRow extends Record<string, number | string> {}
interface PcrRow extends Record<string, number | string | null> {}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('上传过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

async function loadRunPayload(db: DatabaseSync, runId: number): Promise<unknown> {
  const run = db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId) as
    | Record<string, unknown>
    | undefined;
  if (!run) throw new Error('run not found');

  const packets = db
    .prepare('SELECT * FROM packets WHERE run_id = ? ORDER BY arrival_index')
    .all(runId) as PacketRow[];
  const sections = db
    .prepare('SELECT * FROM sections WHERE run_id = ? ORDER BY start_packet')
    .all(runId) as SectionRow[];
  const generations = db
    .prepare('SELECT * FROM generations WHERE run_id = ? ORDER BY id')
    .all(runId) as Array<{ kind: string; body_json: string }>;
  const events = db
    .prepare(
      'SELECT packet_index AS packetIndex, pid, kind, message, detail_json AS detailJson FROM timeline_events WHERE run_id = ? ORDER BY id',
    )
    .all(runId) as unknown as Array<{
    packetIndex: number;
    pid: number;
    kind: string;
    message: string;
    detailJson: string;
  }>;
  const pcr = db
    .prepare(
      `SELECT packet_index AS packetIndex, pid, kind, program_number AS programNumber, raw, base,
              extension, unwrapped, delta, discontinuity
       FROM pcr_timeline WHERE run_id = ? ORDER BY packet_index`,
    )
    .all(runId) as PcrRow[];
  const pids = [...new Set(packets.map((p) => Number(p.pid)))].sort((a, b) => a - b);

  return {
    run,
    pids,
    packets: packets.map((row) => ({
      arrivalIndex: Number(row.arrival_index),
      pid: Number(row.pid),
      pusi: row.pusi === 1,
      tei: row.tei === 1,
      priority: row.priority === 1,
      scrambling: Number(row.scrambling),
      afc: Number(row.afc),
      cc: Number(row.cc),
      hasPayload: row.has_payload === 1,
      payloadOffset: row.payload_offset == null ? null : Number(row.payload_offset),
      payloadLength: row.payload_length == null ? null : Number(row.payload_length),
      adaptation:
        row.af_length == null
          ? null
          : {
              length: Number(row.af_length),
              di: row.di === 1,
              rai: row.rai === 1,
              pcr: (row.pcr as string | null) ?? null,
              opcr: (row.opcr as string | null) ?? null,
              stuffing: Number(row.stuffing_bytes),
            },
    })),
    sections: sections.map((row) => ({
      pid: Number(row.pid),
      tableId: Number(row.table_id),
      tableIdExtension: Number(row.table_id_extension),
      version: Number(row.version),
      currentNext: row.current_next === 1,
      sectionNumber: Number(row.section_number),
      lastSectionNumber: Number(row.last_section_number),
      sectionLength: Number(row.section_length),
      totalLength: Number(row.total_length),
      crcValid: row.crc_valid === 1,
      crcExpected: Number(row.crc_expected),
      crcActual: Number(row.crc_actual),
      startPacket: Number(row.start_packet),
      endPacket: Number(row.end_packet),
      pointerField: Number(row.pointer_field),
      carriedPackets: JSON.parse(String(row.carried_packets)) as number[],
    })),
    patGenerations: generations
      .filter((g) => g.kind === 'pat')
      .map((g) => JSON.parse(g.body_json)),
    pmtGenerations: generations
      .filter((g) => g.kind === 'pmt')
      .map((g) => JSON.parse(g.body_json)),
    events: events.map((e) => ({ ...e, detail: JSON.parse(e.detailJson) })),
    pcrTimeline: pcr.map((row) => ({
      packetIndex: Number(row.packetIndex),
      pid: Number(row.pid),
      kind: String(row.kind),
      programNumber: row.programNumber == null ? null : Number(row.programNumber),
      raw: String(row.raw),
      base: String(row.base),
      extension: Number(row.extension),
      unwrapped: String(row.unwrapped),
      deltaFromPrev: row.delta == null ? null : String(row.delta),
      discontinuity: row.discontinuity === 1,
    })),
  };
}

export function reviewBenchApi(dbPath: string = DB_PATH): Plugin {
  return {
    name: 'review-bench-api',
    configureServer(server: ViteDevServer) {
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = openDatabase(dbPath);
      migrate(db);
      const existing = db
        .prepare("SELECT id FROM analysis_runs WHERE name = '内置 fixture' ORDER BY id DESC LIMIT 1")
        .get() as { id: number } | undefined;
      let fixtureRunId: number;
      if (existing) {
        fixtureRunId = existing.id;
      } else {
        const logical = buildFixtureStream();
        const buffer = encodeFrames(logical.packets, 188);
        const result = analyzeBuffer(buffer);
        fixtureRunId = saveAnalysis(db, '内置 fixture', result, result.pcrTimeline, result.frameReason, result.trailing);
      }

      server.middlewares.use('/api', async (req, res, next) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (req.method === 'GET' && url.pathname === '/api/health') {
            json(res, 200, { ok: true, fixtureRunId, runs: listRuns(db) });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/runs') {
            json(res, 200, { runs: listRuns(db) });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/run') {
            const id = Number(url.searchParams.get('id') ?? fixtureRunId);
            json(res, 200, await loadRunPayload(db, id));
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/analyze') {
            const body = await readBody(req);
            const result = analyzeBuffer(body);
            const id = saveAnalysis(db, '上传分析', result, result.pcrTimeline, result.frameReason, result.trailing);
            json(res, 200, { id, frameSize: result.frameSize, packetCount: result.packetCount });
            return;
          }
          next();
        } catch (err) {
          json(res, 500, { error: (err as Error).message });
        }
      });
    },
  };
}
