// Static world model: terrain, structures, line of sight, and a 2 m navigation grid with A*.
import { readFileSync } from "node:fs"
import { join } from "node:path"

export type V3 = [number, number, number]

const NAV_RES = 2

export class World {
  nx: number
  ny: number
  minX: number
  minY: number
  ground: Float32Array
  // up to two solid intervals per 1 m cell (NaN = none), sorted low first
  b1: Float32Array
  t1: Float32Array
  b2: Float32Array
  t2: Float32Array
  surf: Float32Array // walkable surface height under a point (ground, roof or deck)
  struct: Uint8Array // 1 = a structure occupies this cell
  // nav grid
  gx!: number
  gy!: number
  gH!: Float32Array
  gBlocked!: Uint8Array
  gClear!: Float32Array // distance (m, capped) to nearest blocking node
  // trees (vision only)
  treeCount = 0
  trees: Float32Array = new Float32Array(0) // x,y,crownBase,top,crownR,trunkR

  constructor(dir: string, stepUp = 1.2, radius = 2.5, height = 9) {
    const world = JSON.parse(readFileSync(join(dir, "v2/world.json"), "utf8"))
    const ter = world.terrain
    this.nx = ter.nx
    this.ny = ter.ny
    this.minX = ter.minX
    this.minY = ter.minY
    const buf = readFileSync(join(dir, "v2/" + (ter.file ?? "terrain.i16")))
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, (this.nx * this.ny))
    const N = this.nx * this.ny
    const scale = ter.scale ?? 0.01
    this.ground = new Float32Array(N)
    for (let k = 0; k < N; k++) this.ground[k] = i16[k] * scale
    this.b1 = new Float32Array(N).fill(NaN)
    this.t1 = new Float32Array(N).fill(NaN)
    this.b2 = new Float32Array(N).fill(NaN)
    this.t2 = new Float32Array(N).fill(NaN)
    let _t = performance.now(); const _lap = (s: string) => { const n = performance.now(); if (process.env.WPROF) console.error(s, (n - _t).toFixed(0)); _t = n }
    for (const p of world.prisms as any[]) this.raster(p)
    _lap("raster")
    this.surf = new Float32Array(N)
    this.struct = new Uint8Array(N)
    for (let k = 0; k < N; k++) {
      let s = this.ground[k]
      const b1 = this.b1[k]
      if (b1 === b1) {
        if (b1 <= s + height) { s = Math.max(s, this.t1[k]); this.struct[k] = 1 }
        const b2 = this.b2[k]
        if (b2 === b2 && b2 <= s + height) { s = Math.max(s, this.t2[k]); this.struct[k] = 1 }
      }
      this.surf[k] = s
    }
    // trees
    const tr = world.trees
    if (tr && tr.fields && tr.data) {
      const f: string[] = tr.fields
      const n = Math.floor(tr.data.length / f.length)
      const ix = f.indexOf("x"), iy = f.indexOf("y"), iz = f.indexOf("z"), ih = f.indexOf("height")
      const icr = f.indexOf("crownR"), icb = f.indexOf("crownBase"), itr = f.indexOf("trunkR")
      const icx = f.indexOf("crownX"), icy = f.indexOf("crownY")
      this.treeCount = n
      this.trees = new Float32Array(n * 8)
      for (let i = 0; i < n; i++) {
        const o = i * f.length
        const z = tr.data[o + iz]
        this.trees[i * 8] = tr.data[o + ix]
        this.trees[i * 8 + 1] = tr.data[o + iy]
        this.trees[i * 8 + 2] = z + tr.data[o + icb]
        this.trees[i * 8 + 3] = z + tr.data[o + ih]
        this.trees[i * 8 + 4] = tr.data[o + icr]
        this.trees[i * 8 + 5] = tr.data[o + itr]
        this.trees[i * 8 + 6] = icx >= 0 ? tr.data[o + icx] : tr.data[o + ix]
        this.trees[i * 8 + 7] = icy >= 0 ? tr.data[o + icy] : tr.data[o + iy]
      }
    }
    _lap("surf+trees")
    this.buildNav(stepUp, radius, height)
    _lap("nav")
  }

  private addInterval(k: number, b: number, t: number) {
    const b1 = this.b1[k]
    if (b1 !== b1) { this.b1[k] = b; this.t1[k] = t; return }
    const t1 = this.t1[k]
    if (b <= t1 + 0.5 && t >= b1 - 0.5) { this.b1[k] = Math.min(b1, b); this.t1[k] = Math.max(t1, t); this.mergeSlots(k); return }
    const b2 = this.b2[k]
    if (b2 !== b2) {
      if (b < b1) { this.b2[k] = b1; this.t2[k] = t1; this.b1[k] = b; this.t1[k] = t } else { this.b2[k] = b; this.t2[k] = t }
      return
    }
    const t2 = this.t2[k]
    if (b <= t2 + 0.5 && t >= b2 - 0.5) { this.b2[k] = Math.min(b2, b); this.t2[k] = Math.max(t2, t); this.mergeSlots(k); return }
    // three disjoint intervals: merge into the closer one (conservative)
    if (Math.abs(b - t1) < Math.abs(b - b2)) { this.t1[k] = Math.max(t1, t); this.b1[k] = Math.min(b1, b) } else { this.b2[k] = Math.min(b2, b); this.t2[k] = Math.max(t2, t) }
    this.mergeSlots(k)
  }
  private mergeSlots(k: number) {
    const b2 = this.b2[k]
    if (b2 !== b2) return
    if (b2 <= this.t1[k] + 0.5) { this.t1[k] = Math.max(this.t1[k], this.t2[k]); this.b2[k] = NaN; this.t2[k] = NaN }
  }

  private raster(p: any) {
    const ring: number[] = p.ring
    const holes: number[][] = p.holes ?? []
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (let i = 0; i < ring.length; i += 2) {
      x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); y0 = Math.min(y0, ring[i + 1]); y1 = Math.max(y1, ring[i + 1])
    }
    const i0 = Math.max(0, Math.floor(x0 - this.minX)), i1 = Math.min(this.nx - 1, Math.ceil(x1 - this.minX))
    const j0 = Math.max(0, Math.floor(y0 - this.minY)), j1 = Math.min(this.ny - 1, Math.ceil(y1 - this.minY))
    // scanline even-odd fill over ring + holes (matches pip-with-holes for simple polygons)
    const polys = [ring, ...holes.filter((h) => h.length >= 6)]
    const xs: number[] = []
    for (let j = j0; j <= j1; j++) {
      const y = this.minY + j
      xs.length = 0
      for (const r of polys) {
        const n = r.length
        for (let a = 0, b = n - 2; a < n; b = a, a += 2) {
          const ya = r[a + 1], yb = r[b + 1]
          if ((ya > y) !== (yb > y)) xs.push(((r[b] - r[a]) * (y - ya)) / (yb - ya) + r[a])
        }
      }
      if (xs.length < 2) continue
      xs.sort((u, v) => u - v)
      for (let q = 0; q + 1 < xs.length; q += 2) {
        // cells with x strictly left of the crossing count as inside (pip: x < xcross)
        const ia = Math.max(i0, Math.ceil(xs[q] - this.minX - 1e-9))
        const ib = Math.min(i1, Math.ceil(xs[q + 1] - this.minX) - 1)
        for (let i = ia; i <= ib; i++) this.addInterval(j * this.nx + i, p.base, p.top)
      }
    }
  }

  idx(x: number, y: number): number {
    let i = Math.round(x - this.minX), j = Math.round(y - this.minY)
    if (i < 0) i = 0; else if (i >= this.nx) i = this.nx - 1
    if (j < 0) j = 0; else if (j >= this.ny) j = this.ny - 1
    return j * this.nx + i
  }
  groundAt(x: number, y: number) { return this.ground[this.idx(x, y)] }
  surfAt(x: number, y: number) { return this.surf[this.idx(x, y)] }
  inBounds(x: number, y: number) {
    return x > this.minX + 2 && y > this.minY + 2 && x < this.minX + this.nx - 3 && y < this.minY + this.ny - 3
  }

  solid(x: number, y: number, z: number): boolean {
    const k = this.idx(x, y)
    if (z < this.ground[k]) return true
    const b1 = this.b1[k]
    if (b1 !== b1) return false
    if (z >= b1 && z <= this.t1[k]) return true
    const b2 = this.b2[k]
    return b2 === b2 && z >= b2 && z <= this.t2[k]
  }

  /** true when the segment a→b is not blocked by terrain or structures (trees ignored). */
  los(a: V3, b: V3, skipEnd = 1.0, step = 0.9): boolean {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
    const L = Math.hypot(dx, dy, dz)
    if (L < 1e-3) return true
    const n = Math.floor((L - skipEnd) / step)
    for (let s = 1; s <= n; s++) {
      const f = (s * step) / L
      if (this.solid(a[0] + dx * f, a[1] + dy * f, a[2] + dz * f)) return false
    }
    return true
  }

  /** first solid point along a→b (for shots); returns distance or Infinity */
  hitDist(a: V3, b: V3): number {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
    const L = Math.hypot(dx, dy, dz)
    const step = 0.9
    for (let d = step; d < L; d += step) {
      const f = d / L
      if (this.solid(a[0] + dx * f, a[1] + dy * f, a[2] + dz * f)) return d
    }
    return Infinity
  }

  /** crude canopy test: does the segment pass through a dense tree crown or trunk? */
  canopyBlocks(a: V3, b: V3): boolean {
    const t = this.trees
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const L2 = dx * dx + dy * dy
    if (L2 < 1) return false
    let dens = 0
    for (let i = 0; i < this.treeCount; i++) {
      const o = i * 8
      const cx = t[o + 6], cy = t[o + 7], r = t[o + 4]
      // quick reject by bbox
      const px = cx - a[0], py = cy - a[1]
      let u = (px * dx + py * dy) / L2
      if (u < 0.02 || u > 0.98) continue
      const qx = a[0] + dx * u - cx, qy = a[1] + dy * u - cy
      const d2 = qx * qx + qy * qy
      if (d2 > r * r) continue
      const z = a[2] + (b[2] - a[2]) * u
      if (z < t[o + 2] || z > t[o + 3]) continue
      const chord = 2 * Math.sqrt(r * r - d2)
      dens += chord
      if (dens > 6) return true
    }
    return false
  }

  // ---------------- navigation ----------------
  private buildNav(stepUp: number, radius: number, height: number) {
    const gx = (this.gx = Math.ceil(this.nx / NAV_RES))
    const gy = (this.gy = Math.ceil(this.ny / NAV_RES))
    const G = gx * gy
    this.gH = new Float32Array(G)
    this.gBlocked = new Uint8Array(G)
    const r = radius + 0.6
    const offs: number[] = []
    const R = Math.ceil(r)
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) if (di * di + dj * dj <= r * r) offs.push(di, dj)
    for (let J = 0; J < gy; J++) {
      for (let I = 0; I < gx; I++) {
        const i = Math.min(this.nx - 1, I * NAV_RES), j = Math.min(this.ny - 1, J * NAV_RES)
        const k = j * this.nx + i
        const h = this.surf[k]
        const n = J * gx + I
        this.gH[n] = h
        // map edge
        if (i < 4 || j < 4 || i >= this.nx - 5 || j >= this.ny - 5) { this.gBlocked[n] = 1; continue }
        let blocked = 0
        for (let q = 0; q < offs.length; q += 2) {
          const ii = i + offs[q], jj = j + offs[q + 1]
          if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.ny) { blocked = 1; break }
          const kk = jj * this.nx + ii
          if (!this.struct[kk]) continue
          // structure in my footprint taller than a step and not clearing my head
          const b1 = this.b1[kk]
          if (b1 === b1 && this.t1[kk] > h + stepUp && b1 < h + height) { blocked = 1; break }
          const b2 = this.b2[kk]
          if (b2 === b2 && this.t2[kk] > h + stepUp && b2 < h + height) { blocked = 1; break }
        }
        this.gBlocked[n] = blocked
      }
    }
    // clearance (BFS distance to blocked, capped 12 m) for steering preferences
    this.gClear = new Float32Array(G).fill(99)
    const q = new Int32Array(G)
    let qh = 0, qt = 0
    for (let n = 0; n < G; n++) if (this.gBlocked[n]) { this.gClear[n] = 0; q[qt++] = n }
    while (qh < qt) {
      const n = q[qh++]
      const c = this.gClear[n]
      if (c >= 12) continue
      const I = n % gx, J = (n - I) / gx
      for (let d = 0; d < 4; d++) {
        const II = I + (d === 0 ? 1 : d === 1 ? -1 : 0), JJ = J + (d === 2 ? 1 : d === 3 ? -1 : 0)
        if (II < 0 || JJ < 0 || II >= gx || JJ >= gy) continue
        const m = JJ * gx + II
        if (this.gClear[m] > c + NAV_RES) { this.gClear[m] = c + NAV_RES; q[qt++] = m }
      }
    }
    this.g = new Float32Array(G)
    this.came = new Int32Array(G)
    this.stamp = new Uint32Array(G)
    this.closedStamp = new Uint32Array(G)
    this.heap = new Int32Array(G * 4)
    this.heapF = new Float32Array(G * 4)
  }

  node(x: number, y: number): number {
    let I = Math.round((x - this.minX) / NAV_RES), J = Math.round((y - this.minY) / NAV_RES)
    if (I < 0) I = 0; else if (I >= this.gx) I = this.gx - 1
    if (J < 0) J = 0; else if (J >= this.gy) J = this.gy - 1
    return J * this.gx + I
  }
  nodeX(n: number) { return this.minX + (n % this.gx) * NAV_RES }
  nodeY(n: number) { return this.minY + Math.floor(n / this.gx) * NAV_RES }

  /** nearest unblocked node to (x,y) whose height is near z (if given), within r meters */
  freeNode(x: number, y: number, r = 12, z?: number): number {
    const c = this.node(x, y)
    const cI = c % this.gx, cJ = Math.floor(c / this.gx)
    let best = -1, bd = Infinity
    const R = Math.ceil(r / NAV_RES)
    for (let dJ = -R; dJ <= R; dJ++) for (let dI = -R; dI <= R; dI++) {
      const I = cI + dI, J = cJ + dJ
      if (I < 0 || J < 0 || I >= this.gx || J >= this.gy) continue
      const n = J * this.gx + I
      if (this.gBlocked[n]) continue
      let d = Math.hypot(this.nodeX(n) - x, this.nodeY(n) - y)
      if (z !== undefined) d += Math.max(0, Math.abs(this.gH[n] - z) - 1.5) * 3
      if (d < bd) { bd = d; best = n }
    }
    return best
  }

  walkable(n: number) { return n >= 0 && !this.gBlocked[n] }

  /** whether a mech can walk straight from a to b (sampled on the nav grid) */
  straight(ax: number, ay: number, bx: number, by: number, stepUp = 1.2): boolean {
    const L = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.ceil(L / 1.0))
    let prevH = this.gH[this.node(ax, ay)]
    for (let s = 1; s <= n; s++) {
      const f = s / n
      const m = this.node(ax + (bx - ax) * f, ay + (by - ay) * f)
      if (this.gBlocked[m]) return false
      const h = this.gH[m]
      if (h - prevH > stepUp + 1.1) return false
      prevH = h
    }
    return true
  }

  climb = true
  maxClimb = 30
  private jumpSteps = 0
  private jumpCost = 0
  /** from node (I,J) heading in direction d through blocked nodes; returns the landing node or -1 */
  private jumpEdge(I: number, J: number, d: number): number {
    const gx = this.gx, gy = this.gy
    const h0 = this.gH[J * gx + I]
    let maxH = h0
    for (let s = 1; s <= 5; s++) {
      const II = I + DI[d] * s, JJ = J + DJ[d] * s
      if (II < 1 || JJ < 1 || II >= gx - 1 || JJ >= gy - 1) return -1
      const m = JJ * gx + II
      const h = this.gH[m]
      if (h > maxH) maxH = h
      if (!this.gBlocked[m]) {
        if (s < 2) return -1
        const rise = maxH - h0
        if (rise > this.maxClimb) return -1
        this.jumpSteps = s
        this.jumpCost = rise > 1.5 ? 8 + rise * 2.5 : 6
        return m
      }
    }
    return -1
  }

  // A* scratch
  private g!: Float32Array
  private came!: Int32Array
  private stamp!: Uint32Array
  private closedStamp!: Uint32Array
  private heap!: Int32Array
  private heapF!: Float32Array
  private cur = 1
  private hn = 0

  private push(n: number, f: number) {
    let i = this.hn++
    const h = this.heap, hf = this.heapF
    while (i > 0) {
      const p = (i - 1) >> 1
      if (hf[p] <= f) break
      h[i] = h[p]; hf[i] = hf[p]; i = p
    }
    h[i] = n; hf[i] = f
  }
  private pop(): number {
    const h = this.heap, hf = this.heapF
    const top = h[0]
    const n = --this.hn
    if (n <= 0) return top
    const x = h[n], xf = hf[n]
    let i = 0
    for (;;) {
      let c = 2 * i + 1
      if (c >= n) break
      if (c + 1 < n && hf[c + 1] < hf[c]) c++
      if (hf[c] >= xf) break
      h[i] = h[c]; hf[i] = hf[c]; i = c
    }
    h[i] = x; hf[i] = xf
    return top
  }

  /**
   * A* from start node to goal node. penalty(n) returns an extra cost multiplier term (>=0) per meter.
   * Returns list of node ids (start..goal) or null.
   */
  astar(start: number, goal: number, penalty: ((n: number) => number) | null, maxExpand = 30000, stepUp = 1.2, hw = 1.5, deadline = Infinity): number[] | null {
    if (start < 0 || goal < 0) return null
    const gx = this.gx, gy = this.gy
    const id = ++this.cur
    this.hn = 0
    const gI = goal % gx, gJ = Math.floor(goal / gx)
    const hfn = (n: number) => {
      const dI = Math.abs((n % gx) - gI), dJ = Math.abs(Math.floor(n / gx) - gJ)
      return hw * NAV_RES * (Math.max(dI, dJ) + 0.41421356 * Math.min(dI, dJ))
    }
    this.g[start] = 0
    this.stamp[start] = id
    this.came[start] = -1
    this.push(start, hfn(start))
    let expanded = 0
    let bestN = start, bestH = hfn(start)
    while (this.hn > 0) {
      const n = this.pop()
      if (this.closedStamp[n] === id) continue
      this.closedStamp[n] = id
      if (n === goal) return this.recon(n)
      const hcur = hfn(n)
      if (hcur < bestH) { bestH = hcur; bestN = n }
      if (++expanded > maxExpand) break
      if ((expanded & 255) === 0 && performance.now() > deadline) break
      const I = n % gx, J = (n - I) / gx
      const hN = this.gH[n]
      const gn = this.g[n]
      for (let d = 0; d < 8; d++) {
        const dI = DI[d], dJ = DJ[d]
        const II = I + dI, JJ = J + dJ
        if (II < 0 || JJ < 0 || II >= gx || JJ >= gy) continue
        let m = JJ * gx + II
        if (this.closedStamp[m] === id) continue
        let len = d < 4 ? NAV_RES : NAV_RES * 1.41421356
        let extra = 0
        if (this.gBlocked[m]) {
          // climb / drop edge: march through the blocked band to the first free node
          if (!this.climb) continue
          const e = this.jumpEdge(I, J, d)
          if (e < 0) continue
          m = e
          if (this.closedStamp[m] === id) continue
          const steps = this.jumpSteps
          len *= steps
          extra = this.jumpCost
        } else {
          const rise = this.gH[m] - hN
          if (rise > Math.max(stepUp, len * 1.1)) {
            if (!this.climb || rise > this.maxClimb) continue
            extra = 6 + rise * 2.5
          }
          if (d >= 4 && (this.gBlocked[J * gx + II] || this.gBlocked[JJ * gx + I])) continue
        }
        let c = len + extra
        const cl = this.gClear[m]
        if (cl < 6) c += (6 - cl) * 0.15
        if (penalty) c += len * penalty(m)
        const ng = gn + c
        if (this.stamp[m] !== id || ng < this.g[m]) {
          this.stamp[m] = id
          this.g[m] = ng
          this.came[m] = n
          this.push(m, ng + hfn(m))
        }
      }
    }
    // partial path to the closest node reached
    if (bestN !== start) { const p = this.recon(bestN); (p as any).partial = true; return p }
    return null
  }

  private recon(n: number): number[] {
    const out: number[] = []
    while (n >= 0) { out.push(n); n = this.came[n] }
    out.reverse()
    return out
  }

  /**
   * Dijkstra from start out to maxCost; returns the first settled node for which accept(n) is true,
   * with its path. Used for cover search.
   */
  nearestWhere(start: number, maxCost: number, accept: (n: number, cost: number) => boolean, penalty: ((n: number) => number) | null = null, stepUp = 1.2, maxChecks = 1500, deadline = Infinity): number[] | null {
    if (start < 0) return null
    const gx = this.gx, gy = this.gy
    const id = ++this.cur
    this.hn = 0
    this.g[start] = 0
    this.stamp[start] = id
    this.came[start] = -1
    this.push(start, 0)
    let checks = 0
    while (this.hn > 0) {
      const n = this.pop()
      if (this.closedStamp[n] === id) continue
      this.closedStamp[n] = id
      const gn = this.g[n]
      if (gn > maxCost) break
      if (accept(n, gn)) return this.recon(n)
      if (++checks > maxChecks) break
      if ((checks & 7) === 0 && performance.now() > deadline) break
      const I = n % gx, J = (n - I) / gx
      const hN = this.gH[n]
      for (let d = 0; d < 8; d++) {
        const II = I + DI[d], JJ = J + DJ[d]
        if (II < 0 || JJ < 0 || II >= gx || JJ >= gy) continue
        const m = JJ * gx + II
        if (this.gBlocked[m] || this.closedStamp[m] === id) continue
        const len = d < 4 ? NAV_RES : NAV_RES * 1.41421356
        if (this.gH[m] - hN > Math.max(stepUp, len * 1.1)) continue
        if (d >= 4 && (this.gBlocked[J * gx + II] || this.gBlocked[JJ * gx + I])) continue
        let c = len
        if (penalty) c += len * penalty(m)
        const ng = gn + c
        if (this.stamp[m] !== id || ng < this.g[m]) {
          this.stamp[m] = id
          this.g[m] = ng
          this.came[m] = n
          this.push(m, ng)
        }
      }
    }
    return null
  }
}

const DI = [1, -1, 0, 0, 1, 1, -1, -1]
const DJ = [0, 0, 1, -1, 1, -1, 1, -1]

function pip(ring: number[], x: number, y: number): boolean {
  let inside = false
  const n = ring.length
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
