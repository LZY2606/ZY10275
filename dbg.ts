import { detectFrameSize } from './src/core/packet.js';
import { buildFixtureStream, encodeFrames } from './src/core/fixture.js';
const fx = buildFixtureStream();
const buf = encodeFrames(fx.packets, 192);
console.log([0,188,192,384].map(i=>buf[i]!.toString(16)));
console.log(detectFrameSize(buf));
