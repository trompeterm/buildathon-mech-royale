import { World } from "../src/world.ts"
const W = new World("kit/arena")
const me = [270, -315, 3], threats: any[] = [[270 + 77 * Math.cos(1.2), -315 + 77 * Math.sin(1.2), 10], [270 + 159 * Math.cos(1.3), -315 + 159 * Math.sin(1.3), 10]]
const s = W.freeNode(me[0], me[1], 10, me[2])
let evals = 0, near = 0
const t0 = performance.now()
const hidden = (x: number, y: number, h: number) => threats.every((t) => !W.los(t, [x, y, h + 8.7], 0.5) && !W.los(t, [x, y, h + 4.5], 0.5))
const p = W.nearestWhere(s, 200, (n) => { evals++; if (W.gClear[n] <= 7) near++; return hidden(W.nodeX(n), W.nodeY(n), W.gH[n]) }, null, 1.2, 50000)
console.log("found", p && [W.nodeX(p.at(-1)!), W.nodeY(p.at(-1)!)], "cost", p?.length, "evals", evals, "nearwall", near, (performance.now() - t0).toFixed(1), "ms")
