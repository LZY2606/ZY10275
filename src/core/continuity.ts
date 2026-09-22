/** transport_stream 连续计数分析（按 PID 独立状态，严格按到达顺序）。
 *
 * - CC 只在包含 payload（afc=1 或 3）时递增；只含 adaptation 的包不递增；
 * - CC 相同且 afc 完全相同：合法重复（duplicate）；
 * - CC 回退但不重复：乱序（reorder），不当丢包；
 * - CC 前跳（mod 16）：gap，missing=distance-1，缺口归因到该 PID；
 * - discontinuity_indicator 只重置“这一个 PID”的期望，绝不波及其它 PID，
 *   也不构成全局重置。
 */

import { AFC_ADAPTATION_ONLY } from './mpeg.js';
import type { TimelineEvent, TsPacket } from './types.js';

interface CcState {
  lastCc: number;
  lastAfc: number;
  initialized: boolean;
  lastPacket: number;
  /** 上一包是否为合法重复（允许同一 payload 连续出现多次）。 */
  expectingDuplicate: boolean;
}

export function analyzeContinuity(packets: readonly TsPacket[]): TimelineEvent[] {
  const state = new Map<number, CcState>();
  const events: TimelineEvent[] = [];

  for (const p of packets) {
    let s = state.get(p.pid);
    if (!s) {
      s = { lastCc: -1, lastAfc: -1, initialized: false, lastPacket: -1, expectingDuplicate: false };
      state.set(p.pid, s);
    }

    if (p.adaptation?.discontinuityIndicator) {
      events.push({
        packetIndex: p.arrivalIndex,
        pid: p.pid,
        kind: 'discontinuity',
        message: `PID 0x${p.pid.toString(16).padStart(4, '0')} discontinuity_indicator=1（仅重置该 PID 的 CC/PCR 预期）`,
        detail: { cc: p.continuityCounter, afc: p.adaptationFieldControl },
      });
      s.initialized = false;
      s.expectingDuplicate = false;
    }

    const hasPayload = p.payload !== null;
    if (!hasPayload) {
      if (p.adaptationFieldControl === AFC_ADAPTATION_ONLY) {
        events.push({
          packetIndex: p.arrivalIndex,
          pid: p.pid,
          kind: 'adaptation-only',
          message: `PID 0x${p.pid.toString(16).padStart(4, '0')} 只含 adaptation（CC 不递增）`,
          detail: { cc: p.continuityCounter },
        });
      }
      // afc=0 reserved：无 payload 同样不参与 CC 序列，但保留现场。
      s.lastPacket = p.arrivalIndex;
      continue;
    }

    if (!s.initialized) {
      s.initialized = true;
      s.lastCc = p.continuityCounter;
      s.lastAfc = p.adaptationFieldControl;
      s.lastPacket = p.arrivalIndex;
      s.expectingDuplicate = false;
      continue;
    }

    const cc = p.continuityCounter;
    if (cc === s.lastCc) {
      if (p.adaptationFieldControl === s.lastAfc) {
        events.push({
          packetIndex: p.arrivalIndex,
          pid: p.pid,
          kind: 'cc-duplicate',
          message: `PID 0x${p.pid.toString(16).padStart(4, '0')} CC=${cc} 合法重复包（payload 重复）`,
          detail: { cc, previousPacket: s.lastPacket },
        });
        s.expectingDuplicate = true;
      } else {
        events.push({
          packetIndex: p.arrivalIndex,
          pid: p.pid,
          kind: 'cc-gap',
          message: `PID 0x${p.pid.toString(16).padStart(4, '0')} CC 同为 ${cc} 但 afc ${s.lastAfc}→${p.adaptationFieldControl}，疑似丢包`,
          detail: { cc, previousAfc: s.lastAfc, afc: p.adaptationFieldControl },
        });
        s.expectingDuplicate = false;
      }
    } else {
      const forward = (cc - s.lastCc + 16) % 16;
      if (forward <= 8) {
        // 前向：+1 正常，+2..+8 为真实缺口。
        if (forward >= 2) {
          const missing = forward - 1;
          events.push({
            packetIndex: p.arrivalIndex,
            pid: p.pid,
            kind: 'cc-gap',
            message: `PID 0x${p.pid.toString(16).padStart(4, '0')} CC ${s.lastCc}→${cc}：真实丢包 ${missing} 个`,
            detail: { from: s.lastCc, to: cc, missing, previousPacket: s.lastPacket },
          });
        }
        s.expectingDuplicate = false;
      } else {
        // 后向（mod 16 距离 > 8）：旧 CC 的包迟到，乱序而非丢包。
        events.push({
          packetIndex: p.arrivalIndex,
          pid: p.pid,
          kind: 'cc-reorder',
          message: `PID 0x${p.pid.toString(16).padStart(4, '0')} CC ${s.lastCc}→${cc} 回退：乱序到达`,
          detail: { from: s.lastCc, to: cc, previousPacket: s.lastPacket },
        });
        s.expectingDuplicate = false;
      }
    }

    s.lastCc = cc;
    s.lastAfc = p.adaptationFieldControl;
    s.lastPacket = p.arrivalIndex;
  }

  return events;
}
