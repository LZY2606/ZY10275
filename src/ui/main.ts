import type { EventRow, PacketRow, PcrSample, StateSnapshot } from '../core/types'

interface Summary {
  packetSize: number
  packetCount: number
  patGenerations: { gen: number; startIdx: number; version: number; programs: { program: number; pid: number }[] }[]
  pmtGenerations: {
    gen: number
    pid: number
    program: number
    startIdx: number
    version: number
    pcrPid: number
    streams: { streamType: number; pid: number; descriptors: { tag: number; data: string }[] }[]
  }[]
  sections: {
    pid: number
    tableId: number
    version: number
    currentNext: boolean
    startIdx: number
    endIdx: number
    crcOk: boolean
    error?: string
  }[]
}

const COLORS = ['#58a6ff', '#3fb950', '#d2a8ff', '#ffa657', '#56d4dd', '#ff7b72', '#e3b341']

const el = (id: string) => document.getElementById(id)!
const clock = el('clock') as HTMLCanvasElement
const timeline = el('timeline') as HTMLCanvasElement
const statusEl = el('status')

let streamId: number | null = null
let packetCount = 0
let packets: PacketRow[] = []
let pcr: PcrSample[] = []
let events: EventRow[] = []
let summary: Summary | null = null
let selected = 0

const hexPid = (pid: number) => `0x${pid.toString(16).padStart(4, '0')}`
const hexType = (t: number) => `0x${t.toString(16).padStart(2, '0')}`

async function loadFixture() {
  const r = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'sample' }),
  })
  const j = await r.json()
  streamId = j.streamId
  await refresh()
}

async function uploadFile(file: File) {
  const r = await fetch('/api/analyze-file', { method: 'POST', body: file })
  const j = await r.json()
  if (!r.ok) {
    statusEl.textContent = `错误: ${j.error}`
    return
  }
  streamId = j.streamId
  await refresh()
}

async function refresh() {
  const [s, p, c, e] = await Promise.all([
    fetch(`/api/streams/${streamId}/summary`).then((x) => x.json()),
    fetch(`/api/streams/${streamId}/packets?from=0&to=100000`).then((x) => x.json()),
    fetch(`/api/streams/${streamId}/pcr`).then((x) => x.json()),
    fetch(`/api/streams/${streamId}/events`).then((x) => x.json()),
  ])
  summary = s
  packets = p
  pcr = c
  events = e
  packetCount = s.packetCount
  selected = 0
  statusEl.textContent = `封装 ${s.packetSize} 字节 · ${s.packetCount} 包 · PAT 代次 ${s.patGenerations.length} · PMT 代次 ${s.pmtGenerations.length}`
  drawClock()
  drawTimeline()
  renderEvents()
  await selectPacket(0)
}

const PAD_L = 64
const PAD_R = 16
const PAD_T = 16
const PAD_B = 28

function drawClock() {
  const ctx = clock.getContext('2d')!
  const w = clock.width
  const h = clock.height
  ctx.clearRect(0, 0, w, h)
  if (!packetCount || !summary) return
  const xFor = (idx: number) => PAD_L + (idx / Math.max(1, packetCount - 1)) * (w - PAD_L - PAD_R)
  // generation boundary lines
  for (const g of summary.patGenerations) {
    const x = xFor(g.startIdx)
    ctx.strokeStyle = '#3fb95066'
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(x, PAD_T)
    ctx.lineTo(x, h - PAD_B)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#3fb950'
    ctx.fillText(`PAT v${g.version}`, x + 2, PAD_T + 10)
  }
  for (const g of summary.pmtGenerations) {
    const x = xFor(g.startIdx)
    ctx.strokeStyle = '#d2a8ff44'
    ctx.setLineDash([2, 3])
    ctx.beginPath()
    ctx.moveTo(x, PAD_T)
    ctx.lineTo(x, h - PAD_B)
    ctx.stroke()
    ctx.setLineDash([])
  }
  // event markers
  for (const ev of events) {
    if (ev.kind === 'gap') {
      const x = xFor(ev.idx)
      ctx.fillStyle = '#ff5257'
      ctx.fillRect(x - 1, PAD_T, 2, h - PAD_T - PAD_B)
    } else if (ev.kind === 'crc_error' || ev.kind === 'section_error') {
      const x = xFor(ev.idx)
      ctx.fillStyle = '#ff5257aa'
      ctx.fillText('CRC', x - 8, h / 2)
    }
  }
  if (pcr.length === 0) return
  const minY = Math.min(...pcr.map((s) => s.unwrapped27))
  const maxY = Math.max(...pcr.map((s) => s.unwrapped27))
  const span = Math.max(1, maxY - minY)
  const yFor = (v: number) => h - PAD_B - ((v - minY) / span) * (h - PAD_T - PAD_B)
  ctx.strokeStyle = '#2a323c'
  ctx.fillStyle = '#7d8590'
  for (let i = 0; i <= 4; i++) {
    const y = PAD_T + (i / 4) * (h - PAD_T - PAD_B)
    ctx.beginPath()
    ctx.moveTo(PAD_L, y)
    ctx.lineTo(w - PAD_R, y)
    ctx.stroke()
    const sec = (maxY - (i / 4) * span) / 27e6
    ctx.fillText(`${sec.toFixed(1)}s`, 6, y + 4)
  }
  // lines per (program, pmtGen) — never merge different gens
  const lines = new Map<string, PcrSample[]>()
  for (const s of pcr) {
    const key = `p${s.program ?? '-'} g${s.pmtGen ?? '-'} pid${s.pid}`
    const arr = lines.get(key) ?? []
    arr.push(s)
    lines.set(key, arr)
  }
  let ci = 0
  for (const [key, arr] of lines) {
    ctx.strokeStyle = COLORS[ci++ % COLORS.length]
    ctx.fillStyle = ctx.strokeStyle
    ctx.beginPath()
    arr.forEach((s, i) => {
      const x = xFor(s.idx)
      const y = yFor(s.unwrapped27)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
    const last = arr[arr.length - 1]
    ctx.fillText(key, xFor(last.idx) + 3, yFor(last.unwrapped27))
  }
  // cursor
  const cx = xFor(selected)
  ctx.strokeStyle = '#e3b341'
  ctx.beginPath()
  ctx.moveTo(cx, PAD_T)
  ctx.lineTo(cx, h - PAD_B)
  ctx.stroke()
  ctx.fillStyle = '#d7dee6'
  ctx.fillText(`#${selected}`, Math.min(cx + 4, w - 40), h - 8)
  // x labels
  ctx.fillStyle = '#7d8590'
  ctx.fillText('packet 0', PAD_L, h - 8)
  ctx.fillText(`packet ${packetCount - 1}`, w - PAD_R - 70, h - 8)
}

function drawTimeline() {
  const ctx = timeline.getContext('2d')!
  const w = timeline.width
  const h = timeline.height
  ctx.clearRect(0, 0, w, h)
  if (!packetCount) return
  const pids = [...new Set(packets.map((p) => p.pid))].sort((a, b) => a - b)
  const rowH = Math.max(8, Math.min(20, (h - 20) / Math.max(1, pids.length)))
  const xFor = (idx: number) => (idx / Math.max(1, packetCount - 1)) * w
  ctx.fillStyle = '#7d8590'
  pids.forEach((pid, row) => {
    const y = 4 + row * rowH
    ctx.fillStyle = '#7d8590'
    ctx.fillText(hexPid(pid), 2, y + rowH - 2)
    for (const p of packets.filter((q) => q.pid === pid)) {
      const x = xFor(p.idx)
      if (p.discontinuity) ctx.fillStyle = '#ffa657'
      else if (p.hasPcr || p.hasOpcr) ctx.fillStyle = '#58a6ff'
      else if (!p.hasPayload) ctx.fillStyle = '#566070'
      else ctx.fillStyle = '#8b949e'
      ctx.fillRect(x, y, Math.max(1.5, w / packetCount), rowH - 3)
    }
  })
  const cx = xFor(selected)
  ctx.strokeStyle = '#e3b341'
  ctx.beginPath()
  ctx.moveTo(cx, 0)
  ctx.lineTo(cx, h)
  ctx.stroke()
}

function renderEvents() {
  const box = el('events')
  box.innerHTML = '<table><tr><th>#</th><th>PID</th><th>类型</th><th>详情</th></tr></table>'
  const t = box.querySelector('table')!
  for (const ev of events) {
    const tr = document.createElement('tr')
    tr.className = `ev-${ev.kind}`
    const idx = document.createElement('td')
    idx.textContent = String(ev.idx)
    idx.style.cursor = 'pointer'
    idx.onclick = () => selectPacket(ev.idx)
    tr.append(idx)
    const pid = document.createElement('td')
    pid.textContent = hexPid(ev.pid)
    const kind = document.createElement('td')
    kind.textContent = ev.kind
    const detail = document.createElement('td')
    detail.textContent = JSON.stringify(ev.detail)
    tr.append(pid, kind, detail)
    t.append(tr)
  }
}

function streamTypeName(t: number): string {
  const known: Record<number, string> = {
    0x02: 'MPEG-2 video', 0x03: 'MPEG-1 audio', 0x0f: 'AAC ADTS', 0x1b: 'H.264 video', 0x24: 'HEVC video',
  }
  return known[t] ?? '未知(保留原值)'
}

async function selectPacket(idx: number) {
  selected = idx
  const [state, pkt] = await Promise.all([
    fetch(`/api/streams/${streamId}/state?idx=${idx}`).then((x) => x.json()) as Promise<StateSnapshot>,
    Promise.resolve(packets[idx]),
  ])
  drawClock()
  drawTimeline()
  el('state').innerHTML = ''
  const st = document.createElement('table')
  st.innerHTML = '<tr><th>PID</th><th>角色</th><th>节目</th><th>stream_type</th><th>PMT代次</th></tr>'
  for (const e of state.pids) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${hexPid(e.pid)}</td><td>${e.role}</td><td>${e.program ?? '-'}</td>` +
      `<td>${e.streamType !== undefined ? `${hexType(e.streamType)} ${streamTypeName(e.streamType)}` : '-'}</td>` +
      `<td>${e.pmtGen ?? '-'}</td>`
    st.append(tr)
  }
  el('state').append(st)
  const p = pkt as PacketRow | undefined
  el('packet').innerHTML = p
    ? `<table>
      <tr><td>序号</td><td>${p.idx}</td></tr>
      <tr><td>PID</td><td>${hexPid(p.pid)}</td></tr>
      <tr><td>AFC</td><td>${p.afc} (${['reserved','payload','adaptation','both'][p.afc] ?? '?'})</td></tr>
      <tr><td>PUSI</td><td>${p.pusi}</td><td>TEI</td><td>${p.tei}</td></tr>
      <tr><td>CC</td><td>${p.cc}</td><td>payload</td><td>${p.hasPayload}</td></tr>
      <tr><td>PCR</td><td>${p.hasPcr}</td><td>OPCR</td><td>${p.hasOpcr}</td></tr>
      <tr><td>discontinuity</td><td>${p.discontinuity}</td></tr>
    </table>`
    : ''
}

clock.addEventListener('click', (e) => {
  const rect = clock.getBoundingClientRect()
  const x = ((e.clientX - rect.left) / rect.width) * clock.width
  const ratio = (x - PAD_L) / (clock.width - PAD_L - PAD_R)
  const idx = Math.max(0, Math.min(packetCount - 1, Math.round(ratio * (packetCount - 1))))
  selectPacket(idx)
})
timeline.addEventListener('click', (e) => {
  const rect = timeline.getBoundingClientRect()
  const ratio = (e.clientX - rect.left) / rect.width
  const idx = Math.max(0, Math.min(packetCount - 1, Math.round(ratio * packetCount)))
  selectPacket(idx)
})
el('loadFixture').addEventListener('click', loadFixture)
el('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) uploadFile(f)
})
el('upload').addEventListener('click', () => (el('file') as HTMLInputElement).click())

loadFixture()
