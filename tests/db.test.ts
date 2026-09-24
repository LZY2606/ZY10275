import { describe, it, expect } from 'vitest'
import { analyze, stateAt } from '../src/core/analyzer'
import { buildSampleStream } from '../src/fixtures/sampleStream'
import { openDb, saveAnalysis, loadAnalysis, loadStateAt } from '../src/server/db'

describe('sqlite persistence', () => {
  it('applies migrations and round-trips an analysis', () => {
    const db = openDb(':memory:')
    const result = analyze(buildSampleStream())
    const id = saveAnalysis(db, 'fixture:sample', result)
    const loaded = loadAnalysis(db, id)
    expect(loaded.packetCount).toBe(result.packetCount)
    expect(loaded.patGenerations).toEqual(result.patGenerations)
    expect(loaded.pmtGenerations).toEqual(result.pmtGenerations)
    expect(loaded.events).toEqual(result.events)
    expect(loaded.pcrSamples).toEqual(result.pcrSamples)
    expect(loaded.sections).toEqual(result.sections)
    expect(loadStateAt(db, id, 10)).toEqual(stateAt(result, 10))
    expect(loadStateAt(db, id, 20)).toEqual(stateAt(result, 20))
    db.close()
  })
  it('migrations are idempotent', () => {
    const db = openDb(':memory:')
    expect(() => saveAnalysis(db, 'x', analyze(buildSampleStream()))).not.toThrow()
    db.close()
  })
})
