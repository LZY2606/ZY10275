import { it } from 'vitest';
import { analyzeBuffer } from './src/core/analyzer.js';
import { buildFixtureStream, encodeFrames } from './src/core/fixture.js';
it('dbg', () => {
  const fx = buildFixtureStream();
  const r = analyzeBuffer(encodeFrames(fx.packets, 188));
  console.log('sections', r.sections.map(s => `pid=${s.pid.toString(16)} tid=${s.tableId} v=${s.version} crc=${s.crcValid} len=${s.totalLength} span=${s.carriedPackets.length}`));
  console.log('issues', r.issues.map(i=>i.reason));
  console.log('pat', r.patGenerations.length, 'pmt', r.pmtGenerations.length);
});
