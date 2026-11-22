// does the house bot's aim lead or lag our motion? project its aim offset (at our range) on our lateral velocity
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
const L = gunzipSync(readFileSync("kit/check/stream.jsonl.gz")).toString().trim().split("\n").map((l) => JSON.parse(l))
const rows: { tau: number; spd: number; chg: boolean; id: number }[] = []
for (const o of L) {
  if (o.type !== "obs") continue
  for (const m of o.mechs) {
    if (m.kind !== "mech") continue
    const dx = o.self.pos[0] - m.pos[0], dy = o.self.pos[1] - m.pos[1], d = Math.hypot(dx, dy)
    if (d < 20 || d > 250) continue
    const toMe = Math.atan2(dy, dx)
    let e = m.aim[0] - toMe; e = ((e + 3 * Math.PI) % (2 * Math.PI)) - Math.PI
    if (Math.abs(e) > 0.3) continue // not aiming at us
    // our velocity relative to theirs, lateral component (perpendicular to line, +left of their view)
    const rvx = o.self.vel[0] - m.vel[0], rvy = o.self.vel[1] - m.vel[1]
    const lat = (rvx * -dy + rvy * dx) / d
    if (Math.abs(lat) < 4) continue
    const off = e * d // lateral metres of aim offset (+ = left)
    rows.push({ tau: off / lat, spd: lat, chg: !!m.charging, id: m.id })
  }
}
const stat = (a: number[]) => { a.sort((x, y) => x - y); return `n=${a.length} p25 ${a[Math.floor(a.length * 0.25)]?.toFixed(2)} med ${a[Math.floor(a.length / 2)]?.toFixed(2)} p75 ${a[Math.floor(a.length * 0.75)]?.toFixed(2)}` }
console.log("all     tau(s) = aimOffset/lateralSpeed:", stat(rows.map((r) => r.tau)))
console.log("charging:", stat(rows.filter((r) => r.chg).map((r) => r.tau)))
for (const id of [...new Set(rows.map((r) => r.id))]) console.log("mech", id, stat(rows.filter((r) => r.id === id).map((r) => r.tau)))
