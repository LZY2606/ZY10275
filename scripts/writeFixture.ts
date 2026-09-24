import { writeFileSync } from 'node:fs'
import { buildSampleStream } from '../src/fixtures/sampleStream'

const out = process.argv[2] ?? 'data/sample.ts'
writeFileSync(out, Buffer.from(buildSampleStream()))
console.log(`wrote ${out} (${buildSampleStream().length} bytes, 188-byte packets)`)
