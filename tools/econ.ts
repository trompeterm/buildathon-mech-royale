// economy eval: house bots never fire; average cube count at 60/120/200 s. bun tools/econ.ts [total] [seed] [procs]
const [total = "24", seed = "201", procs = "6"] = process.argv.slice(2)
const T = +total, S = +seed, P = +procs, per = Math.ceil(T / P)
const jobs = []
for (let p = 0; p < P; p++) {
  const n = Math.min(per, T - p * per)
  if (n > 0) jobs.push(Bun.spawn(["bun", "tools/sim.ts", String(n), String(S + p * per)], { stdout: "pipe", stderr: "ignore", env: { ...process.env, SIM_HARMLESS: "1" } }))
}
const c: number[][] = [[], [], []]
for (const j of jobs) for (const l of (await new Response(j.stdout).text()).split("\n")) {
  const m = l.match(/c60 (\S+) c120 (\S+) c200 (\S+)/)
  if (m) [1, 2, 3].forEach((k) => { if (m[k] !== "-") c[k - 1].push(+m[k]) })
}
const avg = (a: number[]) => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(2)
console.log(`ECON c60 ${avg(c[0])} c120 ${avg(c[1])} c200 ${avg(c[2])} n=${c[1].length}`)
