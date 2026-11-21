import { World } from "../src/world.ts"
const W = new World("kit/arena")
const [cx, cy] = [+process.argv[2], +process.argv[3]]
for (let dy = 12; dy >= -12; dy -= 3) {
  let row = ""
  for (let dx = -15; dx <= 15; dx += 3) {
    const x = cx + dx, y = cy + dy, n = W.node(x, y)
    row += (W.gBlocked[n] ? "#" : ".") + W.surfAt(x, y).toFixed(0).padStart(3) + (W.struct[W.idx(x, y)] ? "s" : " ") + " "
  }
  console.log(String(dy).padStart(3), row)
}
