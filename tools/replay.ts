import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { Brain, PROF, PROFMAX } from "../src/bot.ts"
const lines = gunzipSync(readFileSync("kit/check/stream.jsonl.gz")).toString().trim().split("\n").map((l) => JSON.parse(l))
const hello = { ...lines[0], map: { dir: "kit/arena", files: [] } }
let t0 = performance.now()
const b = new Brain(hello)
console.log("init", (performance.now() - t0).toFixed(0))
const ts: number[] = []
for (const o of lines.slice(1)) {
  if (o.type !== "obs") continue
  t0 = performance.now()
  b.act(o)
  const d = performance.now() - t0
  ts.push(d)
  if (d > 8) console.log(o.t, d.toFixed(1), b.dbg.slice(0, 120))
}
ts.sort((a, b) => a - b)
console.log("p50", ts[150].toFixed(1), "p90", ts[270].toFixed(1), "max", ts.at(-1)!.toFixed(1))
console.log(Object.entries(PROF).map(([k, v]) => `${k}=${(v / ts.length).toFixed(2)}`).join(" "))
console.log("max", Object.entries(PROFMAX).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" "))
