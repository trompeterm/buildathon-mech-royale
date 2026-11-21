import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
const L = gunzipSync(readFileSync("kit/check/stream.jsonl.gz")).toString().trim().split("\n").map((l) => JSON.parse(l))
let prev: any = null
for (const o of L) {
  if (o.type !== "obs") continue
  const m = o.mechs.find((x: any) => x.id === 10)
  if (!m) { prev = null; continue }
  const d = Math.hypot(m.pos[0] - o.self.pos[0], m.pos[1] - o.self.pos[1])
  const sp = Math.hypot(m.vel[0], m.vel[1])
  const hd = Math.atan2(m.vel[1], m.vel[0])
  const toMe = Math.atan2(o.self.pos[1] - m.pos[1], o.self.pos[0] - m.pos[0])
  const rel = ((hd - toMe + 3 * Math.PI) % (2 * Math.PI)) - Math.PI
  const aimErr = ((m.aim[0] - toMe + 3 * Math.PI) % (2 * Math.PI)) - Math.PI
  if (o.tick % 4 === 0) console.log(o.t.toFixed(1), "d", d.toFixed(0), "spd", sp.toFixed(1), "vz", m.vel[2].toFixed(1), "head-vs-me", rel.toFixed(2), "aimErr", aimErr.toFixed(3), m.charging ? "CHG" : "", "hp", m.hp)
}
