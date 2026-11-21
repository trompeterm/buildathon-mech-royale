// parallel sim evaluation: bun tools/eval.ts [total=24] [seed=201] [procs=4] [extra args...]
const [total = "24", seed = "201", procs = "4", ...extra] = process.argv.slice(2)
const T = +total, S = +seed, P = +procs
const per = Math.ceil(T / P)
const jobs = []
for (let p = 0; p < P; p++) {
  const n = Math.min(per, T - p * per)
  if (n <= 0) break
  jobs.push(Bun.spawn(["bun", "tools/sim.ts", String(n), String(S + p * per), ...extra], { stdout: "pipe", stderr: "ignore" }))
}
let pts: number[] = [], kills = 0, lines: string[] = []
for (const j of jobs) {
  const out = await new Response(j.stdout).text()
  for (const l of out.split("\n")) {
    const m = l.match(/pts (\d+) kills (\d+)/)
    if (m) { pts.push(+m[1]); kills += +m[2]; lines.push(l.slice(0, 110)) }
  }
}
if (extra.includes("-v")) console.log(lines.join("\n"))
const mean = pts.reduce((a, b) => a + b, 0) / pts.length
const sd = Math.sqrt(pts.reduce((a, b) => a + (b - mean) ** 2, 0) / pts.length) / Math.sqrt(pts.length)
console.log(`EVAL mean ${mean.toFixed(2)} ±${sd.toFixed(2)} n=${pts.length} kills/match ${(kills / pts.length).toFixed(2)} early(<=1pt) ${pts.filter((p) => p <= 1).length}`)
