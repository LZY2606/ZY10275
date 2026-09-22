/** 内置确定性 fixture：一段刻意“有故事”的 MPEG-TS。
 *
 * 覆盖：
 * - PMT version 回滚（v1 -> v2 -> v1）；
 * - 跨三个 packet 的 long PMT section（带 descriptor 撑大）；
 * - 合法重复 payload 包；
 * - 只含 adaptation field 的包；
 * - PCR 自然回绕（2^33 base）；
 * - 一个被损坏 CRC 的 PMT section（不得污染上一代映射）；
 * - per-PID discontinuity_indicator；
 * - 真实丢包（CC 缺口）与乱序包，缺口可归因；
 * - 中途节目表切换（加入 program 2，未知 stream_type 保留原值与 descriptor）。
 */

import { crc32Mpeg2 } from './crc.js';
import { SYNC_BYTE } from './mpeg.js';
import type { FrameSize, TsPacket } from './types.js';

export const PID_PMT_1 = 0x0100;
export const PID_PMT_2 = 0x0110;
export const PID_VIDEO = 0x0101;
export const PID_AUDIO = 0x0102;
export const PID_UNKNOWN = 0x0103;
export const PID_VIDEO2 = 0x0111;

export interface FixtureStream {
  /** 逻辑顺序构建出的 188 字节包。 */
  packets: Uint8Array[];
  /** 场景标注（供测试引用，不靠魔数下标）。 */
  marks: FixtureMarks;
}

export interface FixtureMarks {
  patV1Start: number;
  pmtV1Start: number;
  pmtV2Start: number;
  pmtV3BadCrcStart: number;
  pmtV1RollbackStart: number;
  patV2Start: number;
  pmt2Start: number;
  duplicatePayload: { first: number; second: number; pid: number };
  adaptationOnly: { index: number; pid: number };
  pcrWrap: { beforeIndex: number; afterIndex: number; pid: number };
  discontinuity: { index: number; pid: number };
  ccGap: { index: number; pid: number; missing: number };
  reorder: { earlier: number; later: number; pid: number };
  crossThreePacketSection: { start: number; end: number; packets: number[] };
  unknownStreamPid: number;
}

class PacketBuilder {
  private counters = new Map<number, number>();
  packets: Uint8Array[] = [];

  private nextCc(pid: number): number {
    const cc = this.counters.get(pid) ?? 0;
    this.counters.set(pid, (cc + 1) % 16);
    return cc;
  }

  private peekCc(pid: number): number {
    return this.counters.get(pid) ?? 0;
  }

  /** 直接追加一个已构建的 ts 包（不自动管理 CC）。 */
  pushRaw(ts: Uint8Array): number {
    const index = this.packets.length;
    this.packets.push(ts);
    return index;
  }

  /** 追加 PSI packet（payload_unit_start 与 pointer 由 section 分片决定）。 */
  pushPsi(pid: number, payload: Uint8Array, pusi: boolean, ccOverride?: number): number {
    const cc = ccOverride ?? this.nextCc(pid);
    const ts = buildTsPacket(pid, { pusi, cc, payloadOnly: true, payload });
    return this.pushRaw(ts);
  }

  pushPayload(pid: number, payload: Uint8Array, opts: { pusi?: boolean; ccOverride?: number; duplicate?: boolean } = {}): number {
    if (opts.duplicate) {
      const cc = this.counters.get(pid) ?? 0;
      const ts = buildTsPacket(pid, { pusi: !!opts.pusi, cc, payloadOnly: true, payload });
      return this.pushRaw(ts);
    }
    const cc = opts.ccOverride ?? this.nextCc(pid);
    const ts = buildTsPacket(pid, { pusi: !!opts.pusi, cc, payloadOnly: true, payload });
    return this.pushRaw(ts);
  }

  pushAdaptationOnly(pid: number, adaptation: Uint8Array, opts: { ccOverride?: number; advance?: boolean } = {}): number {
    const cc = opts.ccOverride ?? this.peekCc(pid);
    const ts = buildTsPacket(pid, { pusi: false, cc, adaptationOnly: true, adaptation });
    if (opts.advance) this.counters.set(pid, (cc + 1) % 16);
    return this.pushRaw(ts);
  }

  pushAdaptationWithPayload(
    pid: number,
    adaptation: Uint8Array,
    payload: Uint8Array,
    opts: { pusi?: boolean; ccOverride?: number; di?: boolean } = {},
  ): number {
    const cc = opts.ccOverride ?? this.nextCc(pid);
    const ts = buildTsPacket(pid, {
      pusi: !!opts.pusi,
      cc,
      adaptationAndPayload: true,
      adaptation,
      payload,
    });
    return this.pushRaw(ts);
  }
}

interface BuildOpts {
  pusi: boolean;
  cc: number;
  payloadOnly?: boolean;
  adaptationOnly?: boolean;
  adaptationAndPayload?: boolean;
  payload?: Uint8Array;
  adaptation?: Uint8Array;
}

export function buildTsPacket(pid: number, opts: BuildOpts): Uint8Array {
  const ts = new Uint8Array(188).fill(0xff);
  ts[0] = SYNC_BYTE;
  ts[1] = ((opts.pusi ? 1 : 0) << 6) | ((pid >> 8) & 0x1f);
  ts[2] = pid & 0xff;
  let afc = 0;
  if (opts.payloadOnly) afc = 1;
  if (opts.adaptationOnly) afc = 2;
  if (opts.adaptationAndPayload) afc = 3;
  ts[3] = (afc << 4) | (opts.cc & 0x0f);

  if (opts.payloadOnly && opts.payload) {
    ts.set(expandOrTrim(opts.payload, 184), 4);
  } else if (opts.adaptationOnly && opts.adaptation) {
    ts[4] = opts.adaptation.length;
    ts.set(expandOrTrim(opts.adaptation, opts.adaptation.length), 5);
    for (let i = 5 + opts.adaptation.length; i < 188; i++) ts[i] = 0xff;
  } else if (opts.adaptationAndPayload && opts.adaptation && opts.payload) {
    ts[4] = opts.adaptation.length;
    ts.set(expandOrTrim(opts.adaptation, opts.adaptation.length), 5);
    const start = 5 + opts.adaptation.length;
    const room = 188 - start;
    ts.set(expandOrTrim(opts.payload, room), start);
  }
  return ts;
}

function expandOrTrim(data: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(data.subarray(0, Math.min(length, data.length)), 0);
  if (data.length < length) out.fill(0xff, data.length);
  return out;
}

export function buildAdaptationField(opts: {
  pcr?: bigint;
  opcr?: bigint;
  discontinuity?: boolean;
  randomAccess?: boolean;
  extraStuffing?: number;
}): Uint8Array {
  const flags =
    (opts.discontinuity ? 0x80 : 0) |
    (opts.randomAccess ? 0x40 : 0) |
    0x20 |
    (opts.pcr !== undefined ? 0x10 : 0) |
    (opts.opcr !== undefined ? 0x08 : 0);
  const body: number[] = [flags];
  if (opts.pcr !== undefined) body.push(...encodePcr(opts.pcr));
  if (opts.opcr !== undefined) body.push(...encodePcr(opts.opcr));
  for (let i = 0; i < (opts.extraStuffing ?? 0); i++) body.push(0xff);
  return Uint8Array.from([body.length, ...body]);
}

export function encodePcr(raw: bigint): number[] {
  const base = raw / 300n;
  const ext = Number(raw - base * 300n);
  const b: number[] = [];
  b.push(Number((base >> 25n) & 0xffn));
  b.push(Number((base >> 17n) & 0xffn));
  b.push(Number((base >> 9n) & 0xffn));
  b.push(Number((base >> 1n) & 0xffn));
  b.push(Number(((base & 1n) << 7n) | BigInt((ext >> 8) & 0x01) | 0x7en));
  b.push(ext & 0xff);
  return b;
}

function crcAppend(body: number[]): number[] {
  const bytes = Uint8Array.from(body);
  const crc = crc32Mpeg2(bytes);
  return [...body, (crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff];
}

export interface PatArgs {
  version: number;
  current: boolean;
  entries: Array<{ program: number; pid: number }>;
  sectionNumber?: number;
  lastSectionNumber?: number;
}

function buildPatBytes(args: PatArgs): Uint8Array {
  // 3 字节 section header（section_length 占位）+ 5 字节长格式头
  const body = [
    0x00, // table_id
    0xb0, // section_syntax=1 + reserved + 高 4 位 length=0
    0x00,
    0x00,
    0x01, // transport_stream_id
    0xc1 | ((args.version & 0x1f) << 1) | (args.current ? 1 : 0),
    args.sectionNumber ?? 0,
    args.lastSectionNumber ?? 0,
  ];
  for (const e of args.entries) {
    body.push((e.program >> 8) & 0xff, e.program & 0xff, 0xe0 | ((e.pid >> 8) & 0x1f), e.pid & 0xff);
  }
  const sectionLength = body.length - 3 + 4; // 含 CRC
  body[1] = (body[1]! & 0xf0) | ((sectionLength >> 8) & 0x0f);
  body[2] = sectionLength & 0xff;
  return Uint8Array.from(crcAppend(body));
}

export interface DescriptorSpec {
  tag: number;
  bytes: number[];
}

export interface PmtStreamSpec {
  streamType: number;
  pid: number;
  descriptors: DescriptorSpec[];
}

export interface PmtArgs {
  program: number;
  version: number;
  current: boolean;
  pcrPid: number;
  programInfo: DescriptorSpec[];
  streams: PmtStreamSpec[];
}

function descBytes(d: DescriptorSpec): number[] {
  return [d.tag, d.bytes.length, ...d.bytes];
}

export function buildPmtBytes(args: PmtArgs, opts: { badCrc?: boolean } = {}): Uint8Array {
  const programInfo = args.programInfo.flatMap(descBytes);
  const streamBytes: number[] = [];
  for (const st of args.streams) {
    const d = st.descriptors.flatMap(descBytes);
    streamBytes.push(
      st.streamType,
      0xe0 | ((st.pid >> 8) & 0x1f),
      st.pid & 0xff,
      0xf0 | ((d.length >> 8) & 0x0f),
      d.length & 0xff,
      ...d,
    );
  }
  const body = [
    0x02, // table_id PMT
    0xb0,
    0x00, // section_length 占位
    (args.program >> 8) & 0xff,
    args.program & 0xff,
    0xc1 | ((args.version & 0x1f) << 1) | (args.current ? 1 : 0),
    0x00, // section_number
    0x00, // last_section_number
    0xe0 | ((args.pcrPid >> 8) & 0x1f),
    args.pcrPid & 0xff,
    0xf0 | ((programInfo.length >> 8) & 0x0f),
    programInfo.length & 0xff,
    ...programInfo,
    ...streamBytes,
  ];
  const sectionLength = body.length - 3 + 4;
  body[1] = (body[1]! & 0xf0) | ((sectionLength >> 8) & 0x0f);
  body[2] = sectionLength & 0xff;
  if (opts.badCrc) {
    // 翻转一个 section 中部的数据字节，CRC 必然失败。
    const victim = Math.floor(body.length / 2);
    body[victim] = body[victim]! ^ 0xff;
  }
  return Uint8Array.from(crcAppend(body));
}

/** 把 section 切成 184 字节 payload 分片：首片带 pointer_field=0。 */
export function fragmentSection(section: Uint8Array): Uint8Array[] {
  const fragments: Uint8Array[] = [];
  let first = new Uint8Array(184);
  first[0] = 0x00;
  const n0 = Math.min(183, section.length);
  first.set(section.subarray(0, n0), 1);
  fragments.push(first);
  let cursor = n0;
  while (cursor < section.length) {
    const n = Math.min(184, section.length - cursor);
    const frag = new Uint8Array(184);
    frag.set(section.subarray(cursor, cursor + n), 0);
    fragments.push(frag);
    cursor += n;
  }
  return fragments;
}

export function pushSection(
  builder: PacketBuilder,
  pid: number,
  section: Uint8Array,
): { start: number; end: number; packets: number[] } {
  const frags = fragmentSection(section);
  const packets: number[] = [];
  frags.forEach((frag, i) => packets.push(builder.pushPsi(pid, frag, i === 0)));
  return { start: packets[0]!, end: packets[packets.length - 1]!, packets };
}

/** 构造一个最小 PES start 包 payload（含 PTS），后续填充 0xAA。 */
export function pesPayload(streamId: number, pts: number, fill = 0xaa): Uint8Array {
  const ptsBytes = encodePts(pts, streamId === 0xe0 ? 0x21 : 0x21);
  const headerData = Uint8Array.from(ptsBytes);
  const header = [
    0x00,
    0x00,
    0x01,
    streamId,
    0x00,
    0x00, // PES_packet_length 占位（忽略校验，填 0）
    0x80, // flags: PTS only
    headerData.length,
    ...headerData,
  ];
  const out = new Uint8Array(184);
  out.set(header, 0);
  out.fill(fill, header.length);
  return out;
}

function encodePts(pts: number, prefixFirst: number): number[] {
  // '0010' PTS：5 字节
  const b0 = 0x21 | (((pts >>> 30) & 0x07) << 1);
  const b1 = (pts >>> 22) & 0xff;
  const b2 = 0x01 | ((pts >>> 14) & 0xfe);
  const b3 = (pts >>> 7) & 0xff;
  const b4 = 0x01 | ((pts << 1) & 0xfe);
  void prefixFirst;
  return [b0, b1, b2, b3, b4];
}

export function plainPayload(byte: number, pusi: boolean): Uint8Array {
  const out = new Uint8Array(184);
  out.fill(byte);
  if (pusi) out[0] = 0x00; // 仅作区分，非 PSI 不解析
  return out;
}

const PCR_WRAP_RAW = (1n << 33n) * 300n;

export function buildFixtureStream(): FixtureStream {
  const b = new PacketBuilder();
  const marks = {} as FixtureMarks;

  // 1) PAT v1：program 1 -> PMT PID 0x0100；network PID 0x0010。
  marks.patV1Start = pushSection(
    b,
    0x0000,
    buildPatBytes({
      version: 1,
      current: true,
      entries: [
        { program: 0, pid: 0x0010 },
        { program: 1, pid: PID_PMT_1 },
      ],
    }),
  ).start;

  // 2) PMT v1：video/audio，PCR=video；program_info 一个 descriptor。
  const pmtV1 = buildPmtBytes({
    program: 1,
    version: 1,
    current: true,
    pcrPid: PID_VIDEO,
    programInfo: [{ tag: 0x09, bytes: [0x01] }],
    streams: [
      { streamType: 0x1b, pid: PID_VIDEO, descriptors: [{ tag: 0x0a, bytes: [0x10, 0x20] }] },
      { streamType: 0x0f, pid: PID_AUDIO, descriptors: [] },
    ],
  });
  marks.pmtV1Start = pushSection(b, PID_PMT_1, pmtV1).start;

  // 3) 常规视频 PES + PCR。
  b.pushAdaptationWithPayload(
    PID_VIDEO,
    buildAdaptationField({ pcr: 1_000_000n * 300n, randomAccess: true }),
    pesPayload(0xe0, 9000),
    { pusi: true },
  );
  b.pushPayload(PID_VIDEO, plainPayload(0xaa, false));
  b.pushPayload(PID_AUDIO, pesPayload(0xc0, 8990), { pusi: true });

  // 4) 合法重复 payload（视频）：CC 与 afc 完全相同。
  const dupPayload = plainPayload(0xbb, false);
  marks.duplicatePayload = { first: b.pushPayload(PID_VIDEO, dupPayload), second: -1, pid: PID_VIDEO };
  marks.duplicatePayload.second = b.pushPayload(PID_VIDEO, dupPayload, { duplicate: true });

  // 5) 只含 adaptation 的包（PCR），CC 不递增。
  marks.adaptationOnly = {
    index: b.pushAdaptationOnly(PID_VIDEO, buildAdaptationField({ pcr: 1_000_300n * 300n })),
    pid: PID_VIDEO,
  };

  // 6) 跨三个 packet 的 long PMT v2（program_info 用 descriptor 撑到 > 2*183）。
  const paddingDescriptor: DescriptorSpec = {
    tag: 0x07,
    bytes: Array.from({ length: 220 }, (_, i) => (i * 31 + 7) & 0xff),
  };
  const pmtV2 = buildPmtBytes({
    program: 1,
    version: 2,
    current: true,
    pcrPid: PID_VIDEO,
    programInfo: [paddingDescriptor],
    streams: [
      { streamType: 0x1b, pid: PID_VIDEO, descriptors: [] },
      { streamType: 0x0f, pid: PID_AUDIO, descriptors: [] },
      // 未知 stream_type 0x57 + 自定义 descriptor，必须保留原值与 descriptor。
      { streamType: 0x57, pid: PID_UNKNOWN, descriptors: [{ tag: 0xc3, bytes: [0xde, 0xad] }] },
    ],
  });
  const cross = pushSection(b, PID_PMT_1, pmtV2);
  marks.pmtV2Start = cross.start;
  marks.crossThreePacketSection = { start: cross.start, end: cross.end, packets: cross.packets };

  // v2 期间未知流发一个 PES-like payload，证明映射包含未知 stream。
  b.pushPayload(PID_UNKNOWN, pesPayload(0xbd, 0), { pusi: true });

  // 7) PCR 回绕：v2 节目内，PCR 先在接近回绕点，再回到小值（自然 wrap，无 DI）。
  b.pushAdaptationWithPayload(PID_VIDEO, buildAdaptationField({ pcr: PCR_WRAP_RAW - 2000n }), plainPayload(0xcc, false));
  marks.pcrWrap = {
    beforeIndex: b.packets.length - 1,
    afterIndex: -1,
    pid: PID_VIDEO,
  };
  marks.pcrWrap.afterIndex = b.pushAdaptationWithPayload(
    PID_VIDEO,
    buildAdaptationField({ pcr: 3000n }),
    plainPayload(0xcc, false),
  );

  // 8) 坏 CRC 的 PMT v3：不得应用，v2 继续生效。
  const pmtV3Bad = buildPmtBytes(
    {
      program: 1,
      version: 3,
      current: true,
      pcrPid: PID_VIDEO,
      programInfo: [],
      streams: [{ streamType: 0x1b, pid: PID_VIDEO, descriptors: [] }],
    },
    { badCrc: true },
  );
  marks.pmtV3BadCrcStart = pushSection(b, PID_PMT_1, pmtV3Bad).start;

  // 9) PMT 版本回滚到 v1（有效，生成新代次并打 rollback）。
  marks.pmtV1RollbackStart = pushSection(b, PID_PMT_1, pmtV1).start;

  // 10) per-PID discontinuity（只给音频），下一包 CC 可任意，不影响视频 PID。
  marks.discontinuity = {
    index: b.pushAdaptationOnly(PID_AUDIO, buildAdaptationField({ discontinuity: true })),
    pid: PID_AUDIO,
  };
  // DI 后音频 CC 从 5 重新开始（与之前序列不连续，合法）。
  b.pushPayload(PID_AUDIO, plainPayload(0xd0, false), { ccOverride: 5 });

  // 11) 真实丢包：视频 CC 从当前直接 +3（missing=2），缺口归因视频 PID。
  const currentVideoCc = (b as unknown as { counters: Map<number, number> }).counters.get(PID_VIDEO)!;
  marks.ccGap = {
    index: b.pushPayload(PID_VIDEO, plainPayload(0xd1, false), {
      ccOverride: (currentVideoCc + 3) % 16,
    }),
    pid: PID_VIDEO,
    missing: 2,
  };

  // 12) 乱序：音频先发 CC=8 再发 CC=7（回退包），判 reorder 而非 gap。
  const reorderFirst = b.pushPayload(PID_AUDIO, plainPayload(0xd2, false), { ccOverride: 8 });
  const reorderSecond = b.pushPayload(PID_AUDIO, plainPayload(0xd3, false), { ccOverride: 7 });
  marks.reorder = { earlier: reorderFirst, later: reorderSecond, pid: PID_AUDIO };

  // 13) 中途节目表切换：PAT v2 加入 program 2 -> PMT PID 0x0110。
  marks.patV2Start = pushSection(
    b,
    0x0000,
    buildPatBytes({
      version: 2,
      current: true,
      entries: [
        { program: 0, pid: 0x0010 },
        { program: 1, pid: PID_PMT_1 },
        { program: 2, pid: PID_PMT_2 },
      ],
    }),
  ).start;

  marks.pmt2Start = pushSection(
    b,
    PID_PMT_2,
    buildPmtBytes({
      program: 2,
      version: 0,
      current: true,
      pcrPid: PID_VIDEO2,
      programInfo: [],
      streams: [{ streamType: 0x02, pid: PID_VIDEO2, descriptors: [{ tag: 0x05, bytes: [0x42] }] }],
    }),
  ).start;
  b.pushAdaptationWithPayload(PID_VIDEO2, buildAdaptationField({ pcr: 5_000_000n * 300n }), pesPayload(0xe0, 50000), {
    pusi: true,
  });

  return { packets: b.packets, marks };
}

/** 按封装大小输出字节流。192 = 4 字节 ATSC 前导；204 = 16 字节 RS 尾。 */
export function encodeFrames(packets: Uint8Array[], frameSize: FrameSize): Uint8Array {
  const out = new Uint8Array(packets.length * frameSize);
  packets.forEach((p, i) => {
    const base = i * frameSize;
    if (frameSize === 192) {
      out[base] = 0x00;
      out[base + 1] = 0x01;
      out[base + 2] = 0x02;
      out[base + 3] = (i & 0xff);
      out.set(p, base + 4);
    } else if (frameSize === 204) {
      out.set(p, base);
      for (let j = 0; j < 16; j++) out[base + 188 + j] = (i * 7 + j) & 0xff;
    } else {
      out.set(p, base);
    }
  });
  return out;
}

export type { TsPacket };
