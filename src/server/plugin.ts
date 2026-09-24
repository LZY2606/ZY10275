import type { Connect, Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { analyze, stateAt } from '../core/analyzer'
import type { AnalysisResult } from '../core/types'
import { fixtures } from '../fixtures/sampleStream'
import { openDb, saveAnalysis, loadAnalysis } from './db'

const DB_PATH = process.env.TS_REVIEW_DB ?? 'data/review.db'

function send(res: ServerResponse, code: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(json)
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function tsReviewApi(): Plugin {
  return {
    name: 'ts-review-api',
    configureServer(server) {
      const db = openDb(DB_PATH)
      const cache = new Map<number, AnalysisResult>()
      const analysisFor = (id: number): AnalysisResult => {
        let a = cache.get(id)
        if (!a) {
          a = loadAnalysis(db, id)
          cache.set(id, a)
        }
        return a
      }

      const handler: Connect.NextHandleFunction = (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname
        const done = (p: Promise<void> | void) => {
          Promise.resolve(p).catch((err) => send(res, 500, { error: String(err?.message ?? err) }))
        }
        if (req.method === 'GET' && path === '/fixtures') {
          return done(send(res, 200, fixtures.map((f) => ({ name: f.name, description: f.description }))))
        }
        if (req.method === 'POST' && path === '/analyze') {
          return done(
            readBody(req).then((body) => {
              const { name } = JSON.parse(body.toString() || '{}')
              const fixture = fixtures.find((f) => f.name === name)
              if (!fixture) return send(res, 404, { error: `unknown fixture ${name}` })
              const result = analyze(fixture.build())
              const streamId = saveAnalysis(db, `fixture:${name}`, result)
              cache.set(streamId, result)
              send(res, 200, { streamId, packetCount: result.packetCount, packetSize: result.packetSize })
            }),
          )
        }
        if (req.method === 'POST' && path === '/analyze-file') {
          return done(
            readBody(req).then((body) => {
              const result = analyze(new Uint8Array(body))
              const streamId = saveAnalysis(db, 'upload', result)
              cache.set(streamId, result)
              send(res, 200, { streamId, packetCount: result.packetCount, packetSize: result.packetSize })
            }),
          )
        }
        if (req.method === 'GET' && path === '/streams') {
          const rows = db.prepare('SELECT id, name, packet_size, packet_count, created_at FROM streams ORDER BY id DESC').all()
          return done(send(res, 200, rows))
        }
        const m = path.match(/^\/streams\/(\d+)\/(summary|packets|state|pcr|events|generations)$/)
        if (req.method === 'GET' && m) {
          const id = Number(m[1])
          const what = m[2]
          return done(
            (() => {
              const a = analysisFor(id)
              switch (what) {
                case 'summary':
                  send(res, 200, {
                    packetSize: a.packetSize,
                    packetCount: a.packetCount,
                    patGenerations: a.patGenerations,
                    pmtGenerations: a.pmtGenerations,
                    sections: a.sections,
                  })
                  break
                case 'packets': {
                  const from = Number(url.searchParams.get('from') ?? 0)
                  const to = Number(url.searchParams.get('to') ?? a.packetCount - 1)
                  send(res, 200, a.packets.filter((p) => p.idx >= from && p.idx <= to))
                  break
                }
                case 'state':
                  send(res, 200, stateAt(a, Number(url.searchParams.get('idx') ?? 0)))
                  break
                case 'pcr':
                  send(res, 200, a.pcrSamples)
                  break
                case 'events':
                  send(res, 200, a.events)
                  break
                case 'generations':
                  send(res, 200, { pat: a.patGenerations, pmt: a.pmtGenerations })
                  break
              }
            })(),
          )
        }
        next()
      }
      server.middlewares.use('/api', handler)
    },
  }
}
