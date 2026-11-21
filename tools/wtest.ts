import { World } from "../src/world.ts"
let t0 = performance.now()
const w = new World("kit/arena")
console.log("load ms", (performance.now() - t0).toFixed(0))
let blocked = 0; for (const b of w.gBlocked) blocked += b
console.log("nav", w.gx, w.gy, "blocked", blocked, (blocked / w.gBlocked.length).toFixed(3))
const pts: [number, number][] = [[320, -280], [-42, 7], [-400, 300], [500, 300], [-276, 128], [100, -200]]
for (const a of pts) for (const b of pts) {
  if (a === b) continue
  t0 = performance.now()
  const s = w.freeNode(a[0], a[1]), g = w.freeNode(b[0], b[1])
  const p = w.astar(s, g, null, 30000)
  console.log(a, "->", b, p ? p.length * 2 : null, (p as any)?.partial ? "PARTIAL" : "", (performance.now() - t0).toFixed(1), "ms")
}
t0 = performance.now(); let c = 0
for (let i = 0; i < 1000; i++) c += w.los([0, 0, 5], [Math.cos(i) * 150, Math.sin(i) * 150, 5]) ? 1 : 0
console.log("1000 los ms", (performance.now() - t0).toFixed(1), c)
// ascii map
let s = ""
for (let J = w.gy - 1; J >= 0; J -= 6) { for (let I = 0; I < w.gx; I += 3) { const n = J * w.gx + I; s += w.gBlocked[n] ? "#" : w.gH[n] > 3 ? "+" : "." } s += "\n" }
await Bun.write("tools/map.txt", s)
