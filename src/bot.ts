// Mech Royale bot: survive first, kill when favorable.
import { type Action, type ActorObs, draw, type Hello, log, type Observation, run, type WeaponObs } from "./mechfight.ts"
import { World, type V3 } from "./world.ts"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"

const PI = Math.PI
const wrap = (a: number) => { while (a > PI) a -= 2 * PI; while (a < -PI) a += 2 * PI; return a }
const d2 = (a: number[], b: number[]) => Math.hypot(b[0] - a[0], b[1] - a[1])
const d3 = (a: number[], b: number[]) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

// deterministic RNG
function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Track = {
  id: number
  pos: V3
  vel: V3
  aim: [number, number]
  hp: number
  maxHp: number
  cubes: number
  weapons: string[]
  charging: boolean
  seen: number // last time seen in obs.mechs
  visible: boolean // listed this tick
  los: boolean // we have a clear line to it this tick
  lastDmgToMe: number
  dmgToMe: number // decayed damage dealt to me
}

// tuning knobs (env overrides only used by the local simulator)
const K = {
  evadeFight: (process.env.K_EVADEFIGHT ?? "0") === "1",
  laserBand: (process.env.K_LASERBAND ?? "0") === "1",
  calmBoost: (process.env.K_CALMBOOST ?? "1") === "1",
  gunAvoid: (process.env.K_GUNAVOID ?? "0") === "1",
  aggro: (process.env.K_AGGRO ?? "1") === "1",
  aggro2: (process.env.K_AGGRO2 ?? "0") === "1",
  hunt: (process.env.K_HUNT ?? "0") === "1",
  duck: (process.env.K_DUCK ?? "0") === "1",
  gunCharge: (process.env.K_GUNCHARGE ?? "0") === "1",
  focus: (process.env.K_FOCUS ?? "0") === "1",
  farm: (process.env.K_FARM ?? "1") === "1",
  farm2: (process.env.K_FARM2 ?? "1") === "1",
  scan: (process.env.K_SCAN ?? "0") === "1",
  farm3: (process.env.K_FARM3 ?? "0") === "1",
  endgame: (process.env.K_ENDGAME ?? "1") === "1",
  fightLoot: (process.env.K_FIGHTLOOT ?? "1") === "1",
  loot2: (process.env.K_LOOT2 ?? "1") === "1",
  loot3: (process.env.K_LOOT3 ?? "0") === "1",
  drops: (process.env.K_DROPS ?? "1") === "1",
  crateMem: (process.env.K_CRATEMEM ?? "1") === "1",
  sustain: (process.env.K_SUSTAIN ?? "1") === "1",
  stealth: (process.env.K_STEALTH ?? "0") === "1",
  rear: (process.env.K_REAR ?? "0") === "1",
  finish: (process.env.K_FINISH ?? "1") === "1",
  finish2: (process.env.K_FINISH2 ?? "0") === "1",
  capCubes: (process.env.K_CAPCUBES ?? "0") === "1",
}

const DODGE = parseInt(process.env.K_DODGE ?? "0")
const BOOSTLOW = (process.env.K_BOOSTLOW ?? "0") === "1"
const DUCKL = (process.env.K_DUCKL ?? "0") === "1" // duck only from a laser charging at us, cover <= 12 m
const TAU = parseFloat(process.env.K_TAU ?? "0") // lead damping time constant (0 = plain linear lead)

const LATE_PREF = ["plating", "nanites", "armor"]

const UPGRADE_PREF = [
  ...((process.env.K_SUSTAIN ?? "1") === "1" ? ["nanites"] : []),
  // hitscan laser never misses a strafer; faster bullets miss less: those first
  ...((process.env.K_UPG2 ?? "1") === "1"
    ? ["laser_damage", "laser_charge", "gun_velocity", "gun_rate", "gun_damage", "gun_mag", "lightning_efficiency", "armor", "plating", "nanites"]
    : ["gun_rate", "gun_damage", "laser_damage", "laser_charge", "gun_mag", "lightning_efficiency", "armor", "plating", "gun_velocity", "nanites"]), "lightning_chain", "lightning_range", "servos", "sensors", "capacitor", "reactor", "jets",
  "gyros", "laser_pierce", "mortar_reload", "mortar_splash", "mortar_velocity",
]

const WEAPON_VALUE: Record<string, number> = { laser: 3, lightning: (process.env.K_LIGHTNING ?? "0") === "1" ? 3.5 : 2, mortar: 0.5, gun: 0 }

type Goal = { x: number; y: number; z?: number; why: string; id?: number }

export const PROF: Record<string, number> = {}
export const PROFMAX: Record<string, number> = {}
const lap = (k: string, t0: number) => { const d = performance.now() - t0; PROF[k] = (PROF[k] ?? 0) + d; if (d > (PROFMAX[k] ?? 0)) PROFMAX[k] = d }
class Brain {
  name = "oval-survivor"
  C: any
  W: World
  me = -1
  rnd: () => number
  tracks = new Map<number, Track>()
  npcs = new Map<number, Track>()
  t = 0
  // path state
  path: number[] | null = null
  pathGoal: Goal | null = null
  pathT = -99
  pathIdx = 0
  // stuck
  lastPos: V3 = [0, 0, 0]
  stuckSince = -1
  unstickUntil = -1
  unstickDir = 1
  progressT = 0
  progressPos: V3 = [0, 0, 0]
  // combat
  strafe = 1
  strafeUntil = 0
  lastDamagedT = -99
  lastDealtT = -99
  dmgEvents: { t: number; amt: number; by: number | null; bearing: number | null; weapon: string }[] = []
  shortUntil = -1
  hideUntil = -1
  mode = "start"
  badTargets = new Map<number, number>() // pickup/crate/cube id -> until t
  lastTake = -1
  lastTakeT = -99
  heard: { t: number; bearing: number; dist: string; kind: string }[] = []
  dropFail = new Map<number, number>()
  startMs = 0
  planBudgetMs = 18
  jetting = false
  dbg = ""
  lastHideT = -99
  lastTargetId = -1
  lastTargetT = -99
  quiet = false
  fightLooting = false
  chasing = false
  climbWaitT = -99
  noClimbUntil = -99
  lastStuckT = -99
  endgame = false
  fdbg = ""

  constructor(hello: Hello, world?: World, warm = true) {
    this.C = hello.config
    this.me = hello.slot
    this.rnd = mulberry(hello.seed || 12345)
    const m = this.C.mech
    const t0 = performance.now()
    this.W = world ?? new World(hello.map.dir, m.step_up ?? 1.2, m.radius ?? 2.5, m.height ?? 9)
    if (!world) log(`world ${(performance.now() - t0).toFixed(0)} ms`)
    if (warm && process.uptime() < 9 && !process.env.NO_WARMUP) this.warmup(hello)
  }

  /** run a recorded match through a throwaway brain so the JIT has compiled every hot path */
  warmup(hello: Hello) {
    const t0 = performance.now()
    let n = 0
    try {
      const file = join(import.meta.dir, "data", "warm.jsonl.gz")
      if (!existsSync(file)) return
      const lines = gunzipSync(readFileSync(file)).toString().trim().split(String.fromCharCode(10))
      const kinds: (string | null)[] = [null, "laser", "lightning", "mortar"]
      for (let pass = 0; pass < 4; pass++) {
        const b = new Brain(hello, this.W, false)
        const kind = kinds[pass]
        for (let i = 1; i < lines.length; i++) {
          if (performance.now() - t0 > 1500) break
          const o = JSON.parse(lines[i])
          if (o.type !== "obs") continue
          if (kind) {
            o.self.weapons[1] = { kind, cooldown: 0, charge: kind === "laser" ? (i % 9) * 0.1 : undefined, stats: { ...this.C.weapons[kind] } }
            for (const mm of o.mechs) mm.weapons = ["gun", kind]
          }
          if (i % 7 === 0) o.offer = { id: i, expires: o.t + 5, choices: [{ id: "armor" }, { id: "gun_rate" }, { id: "sensors" }] }
          b.act(o)
          n++
        }
      }
    } catch (e) { log("warmup", e) }
    draw.clear()
    log(`warmup ${n} obs in ${(performance.now() - t0).toFixed(0)} ms`)
  }

  elapsed() { return performance.now() - this.startMs }

  // ---------------- zone ----------------
  zoneAt(o: Observation, t: number): { c: [number, number]; r: number } {
    const z = o.zone
    if (t <= z.shrink_start) return { c: z.center, r: z.radius }
    if (t >= z.shrink_end) return { c: z.next_center, r: z.next_radius }
    const f = (t - z.shrink_start) / Math.max(1e-6, z.shrink_end - z.shrink_start)
    return {
      c: [z.center[0] + (z.next_center[0] - z.center[0]) * f, z.center[1] + (z.next_center[1] - z.center[1]) * f],
      r: z.radius + (z.next_radius - z.radius) * f,
    }
  }
  /** the circle we must be inside: the next circle, with a margin */
  safeCircle(o: Observation): { c: [number, number]; r: number } {
    const z = o.zone
    const r = Math.max(0, z.next_radius - Math.min(25, z.next_radius * 0.18 + 3))
    return { c: z.next_center, r }
  }
  /** is point p acceptable to be at around time t (inside the shrinking zone with margin)? */
  safeAt(o: Observation, x: number, y: number, t: number, margin = 6): boolean {
    const zc = this.zoneAt(o, t)
    return Math.hypot(x - zc.c[0], y - zc.c[1]) < zc.r - margin
  }

  // ---------------- perception ----------------
  updateTracks(o: Observation) {
    const me = o.self
    const eye: V3 = [me.pos[0], me.pos[1], me.pos[2] + (me.stats.eye_height ?? 8)]
    for (const tr of this.tracks.values()) { tr.visible = false; tr.los = false }
    for (const tr of this.npcs.values()) { tr.visible = false; tr.los = false }
    for (const m of o.mechs) {
      const map = m.kind === "mech" ? this.tracks : this.npcs
      let tr = map.get(m.id)
      if (!tr) {
        tr = { id: m.id, pos: m.pos, vel: m.vel, aim: m.aim, hp: m.hp ?? 1400, maxHp: m.max_hp ?? 1400, cubes: m.cubes ?? 0, weapons: m.weapons ?? [], charging: !!m.charging, seen: o.t, visible: true, los: false, lastDmgToMe: -99, dmgToMe: 0 }
        map.set(m.id, tr)
      }
      tr.pos = m.pos; tr.vel = m.vel; tr.aim = m.aim
      if (m.hp !== undefined) tr.hp = m.hp
      if (m.max_hp !== undefined) tr.maxHp = m.max_hp
      if (m.cubes !== undefined) tr.cubes = m.cubes
      if (m.weapons) tr.weapons = m.weapons
      tr.charging = !!m.charging
      tr.seen = o.t
      tr.visible = true
      const h = m.kind === "mech" ? 4.5 * (1 + 0.05 * tr.cubes) : 1.8
      tr.los = this.W.los(eye, [m.pos[0], m.pos[1], m.pos[2] + h]) || this.W.los(eye, [m.pos[0], m.pos[1], m.pos[2] + h * 1.8])
    }
    // decay damage memory
    for (const tr of this.tracks.values()) tr.dmgToMe *= 0.97
    for (const e of o.events) {
      if (e.type === "damaged") {
        this.lastDamagedT = o.t
        this.dmgEvents.push({ t: o.t, amt: e.amount, by: e.by, bearing: e.bearing, weapon: e.weapon })
        if (e.by !== null && e.by !== undefined) {
          const tr = this.tracks.get(e.by)
          if (tr) { tr.dmgToMe += e.amount; tr.lastDmgToMe = o.t }
        }
      } else if (e.type === "hit") {
        this.lastDealtT = o.t
      } else if (e.type === "effect") {
        if (e.effect === "short") this.shortUntil = o.t + (this.C.weapons.lightning.short_s ?? 2)
      } else if (e.type === "take_failed") {
        this.badTargets.set(e.id, o.t + 20)
      } else if (e.type === "kill" && K.loot2) {
        // the victim drops its cubes + 2 where it died: remember that spot even if we never saw the cubes
        const tr = this.tracks.get((e as any).target)
        if (tr) this.cubeMem.set(-1000 - tr.id, { id: -1000 - tr.id, pos: [tr.pos[0], tr.pos[1], tr.pos[2]], t: o.t })
      } else if (e.type === "took") {
        this.badTargets.set(e.id, o.t + 999)
      }
    }
    this.dmgEvents = this.dmgEvents.filter((e) => o.t - e.t < 6)
    this.updateLootMem(o)
    for (const s of o.sounds) this.heard.push({ t: o.t - s.age, bearing: s.bearing, dist: s.dist, kind: s.kind })
    this.heard = this.heard.filter((s) => o.t - s.t < 4)
    // forget stale tracks
    for (const [id, tr] of this.tracks) if (o.t - tr.seen > 25) this.tracks.delete(id)
    for (const [id, tr] of this.npcs) if (o.t - tr.seen > 25) this.npcs.delete(id)
  }

  /** recent damage per second from mechs (last 3 s) */
  recentDps(o: Observation, window = 3) {
    let s = 0
    for (const e of this.dmgEvents) if (o.t - e.t <= window && e.weapon !== "zone") s += e.amt
    return s / window
  }

  // ---------------- navigation ----------------
  planTo(o: Observation, g: Goal, penaltyZone = true): boolean {
    const me = o.self
    const W = this.W
    const sameGoal = this.pathGoal && Math.hypot(this.pathGoal.x - g.x, this.pathGoal.y - g.y) < 4 && this.path
    if (sameGoal && o.t - this.pathT < 2.5) { this.pathGoal = g; return true }
    if (this.elapsed() > this.planBudgetMs && sameGoal) return true
    if (this.elapsed() > 30) return !!this.path
    let gx = g.x, gy = g.y
    const D = Math.hypot(gx - me.pos[0], gy - me.pos[1])
    const SEG = 170
    if (D > SEG) { gx = me.pos[0] + ((gx - me.pos[0]) * SEG) / D; gy = me.pos[1] + ((gy - me.pos[1]) * SEG) / D }
    const s = W.freeNode(me.pos[0], me.pos[1], 10, me.pos[2])
    const gn = W.freeNode(gx, gy, D > SEG ? 30 : 14, D > SEG ? undefined : g.z)
    if (s < 0 || gn < 0) { this.path = null; return false }
    let pen: ((n: number) => number) | null = null
    if (penaltyZone) {
      const zc = this.zoneAt(o, o.t + 10)
      const cx = zc.c[0], cy = zc.c[1], r = zc.r
      pen = (n: number) => {
        const x = W.nodeX(n), y = W.nodeY(n)
        const dd = Math.hypot(x - cx, y - cy)
        return dd > r ? 4 : 0
      }
    }
    const _ta = performance.now()
    W.maxClimb = o.t < this.noClimbUntil ? 1.5 : 30
    const p = W.astar(s, gn, pen, 25000, 1.2, 1.5, this.startMs + 24)
    W.maxClimb = 30
    lap('astar', _ta)
    this.path = p
    this.pathGoal = g
    this.pathT = o.t
    this.pathIdx = 0
    return !!p
  }

  /** returns a desired move direction following the current path, and whether to jump/jet */
  follow(o: Observation): { mv: [number, number]; jump: boolean; jet: boolean; dist: number } {
    const me = o.self
    const W = this.W
    const p = this.path
    if (!p || p.length === 0) return { mv: [0, 0], jump: false, jet: false, dist: 0 }
    const x = me.pos[0], y = me.pos[1], z = me.pos[2]
    // advance index to the closest node ahead
    let best = this.pathIdx, bd = Infinity
    for (let i = this.pathIdx; i < Math.min(p.length, this.pathIdx + 12); i++) {
      const dd = Math.hypot(W.nodeX(p[i]) - x, W.nodeY(p[i]) - y)
      if (dd < bd) { bd = dd; best = i }
    }
    this.pathIdx = best
    // lookahead: farthest straight-walkable node within 24 m
    let target = Math.min(p.length - 1, best + 1)
    for (let i = best + 1; i < Math.min(p.length, best + 14); i++) {
      const nx = W.nodeX(p[i]), ny = W.nodeY(p[i])
      if (Math.hypot(nx - x, ny - y) > 24) break
      const hi = W.gH[p[i]]
      if (hi - z > 2.0) break
      if (!W.straight(x, y, nx, ny)) break
      target = i
    }
    const tx = W.nodeX(p[target]), ty = W.nodeY(p[target])
    let dx = tx - x, dy = ty - y
    const L = Math.hypot(dx, dy)
    if (L > 1e-3) { dx /= L; dy /= L }
    // climbing: next nodes are much higher than our feet
    let jump = false, jet = false
    let need = 0
    for (let i = best; i < Math.min(p.length, best + 4); i++) need = Math.max(need, W.gH[p[i]] - z)
    if (need > 1.6) {
      const nearWall = L < 10
      if (nearWall) {
        if (me.grounded) {
          // only start if we have the energy for it
          const req = (need / (me.stats.max_rise_speed ?? 10)) * (me.stats.jet_drain ?? 15) + 8
          if (me.energy >= Math.min(req, me.max_energy - 1)) jump = true
          else { dx *= 0.2; dy *= 0.2; this.climbWaitT = o.t } // wait for energy: no boosting meanwhile
        } else jet = true
      }
    } else if (!me.grounded && this.jetting && need > 0.3) jet = true
    this.jetting = jet || jump
    let rem = 0
    for (let i = best; i < p.length - 1 && i < best + 200; i++) rem += 2
    return { mv: [dx, dy], jump, jet, dist: rem + bd }
  }

  goTo(o: Observation, g: Goal, act: Action): number {
    this.planTo(o, g)
    const f = this.follow(o)
    act.move = f.mv
    if (f.jump) act.jump = true
    if (f.jet) act.boost = true
    return f.dist
  }

  // ---------------- aiming ----------------
  muzzle(o: Observation): V3 {
    const me = o.self
    return [me.pos[0], me.pos[1], me.pos[2] + (me.stats.muzzle_height ?? 7)]
  }

  leadAim(o: Observation, tp: V3, tv: V3, speed: number, hOff: number): { yaw: number; pitch: number; tt: number; pt: V3 } {
    const m = this.muzzle(o)
    let tt = 0
    let pt: V3 = [tp[0], tp[1], tp[2] + hOff]
    const g = this.C.mech.gravity ?? 22
    const airborne = Math.abs(tv[2]) > 0.5
    for (let k = 0; k < 4; k++) {
      const lat = tt + 0.06
      const hl = TAU > 0 ? TAU * (1 - Math.exp(-lat / TAU)) : lat // strafers reverse: expected drift decays
      let pz = tp[2] + tv[2] * lat
      if (airborne) {
        pz -= 0.5 * g * lat * lat
        const s = this.W.surfAt(tp[0] + tv[0] * hl, tp[1] + tv[1] * hl)
        if (pz < s) pz = s
      }
      pt = [tp[0] + tv[0] * hl, tp[1] + tv[1] * hl, pz + hOff]
      const dist = Math.max(0, d3(m, pt) - 3)
      tt = dist / speed
    }
    const yaw = Math.atan2(pt[1] - m[1], pt[0] - m[0])
    const pitch = Math.atan2(pt[2] - m[2], Math.hypot(pt[0] - m[0], pt[1] - m[1]))
    return { yaw, pitch, tt, pt }
  }

  mortarAim(o: Observation, tp: V3, tv: V3): { yaw: number; pitch: number; ok: boolean } {
    const me = o.self
    const ws = this.weapon(o, "mortar")?.stats ?? this.C.weapons.mortar
    const v = ws.speed, g = ws.gravity
    const ox = me.pos[0], oy = me.pos[1], oz = me.pos[2] + (me.stats.height ?? 9) + 0.5
    let tt = 1.5
    let res = { yaw: 0, pitch: 0, ok: false }
    for (let k = 0; k < 4; k++) {
      const px = tp[0] + tv[0] * tt, py = tp[1] + tv[1] * tt, pz = tp[2] + 1
      const dx = Math.hypot(px - ox, py - oy) - 3 * Math.cos(0.6), dz = pz - oz
      const v2 = v * v
      const disc = v2 * v2 - g * (g * dx * dx + 2 * dz * v2)
      if (disc < 0) return { yaw: 0, pitch: 0, ok: false }
      const th = Math.atan((v2 - Math.sqrt(disc)) / (g * dx))
      tt = dx / (v * Math.cos(th))
      res = { yaw: Math.atan2(py - oy, px - ox), pitch: th, ok: true }
    }
    const mn = me.stats.min_pitch ?? -0.7, mx = me.stats.max_pitch ?? 1.3
    if (res.pitch < mn || res.pitch > mx) res.ok = false
    return res
  }

  weapon(o: Observation, kind: string): WeaponObs | null {
    for (const w of o.self.weapons) if (w && w.kind === kind) return w
    return null
  }
  slotOf(o: Observation, kind: string): number {
    const ws = o.self.weapons
    for (let i = 0; i < ws.length; i++) if (ws[i] && ws[i]!.kind === kind) return i
    return -1
  }

  // ---------------- threat model ----------------
  estDps(weapons: string[], dist: number): number {
    let s = 0
    for (const w of weapons) {
      if (w === "gun") s += dist < 100 ? 140 : dist < 180 ? 90 : 40
      else if (w === "laser") s += dist < 280 ? 120 : 0
      else if (w === "lightning") s += dist < 50 ? 220 : 0
      else if (w === "mortar") s += dist < 230 ? 70 : 0
    }
    return s
  }

  // ---------------- main ----------------
  act(o: Observation): Action {
    this.startMs = performance.now()
    this.t = o.t
    const me = o.self
    const act: Action = { tick: o.tick }
    let _t0 = performance.now()
    this.updateTracks(o)
    lap('tracks', _t0)
    const W = this.W
    const pos = me.pos
    const hpFrac = me.hp / me.max_hp

    // upgrades
    if (o.offer) act.pick = this.pickUpgrade(o)

    // enemies
    const enemies = [...this.tracks.values()].filter((t) => t.id !== me.id && o.t - t.seen < 0.01)
    const remembered = [...this.tracks.values()].filter((t) => t.id !== me.id && o.t - t.seen < 8)
    const visibleNpcs = [...this.npcs.values()].filter((t) => o.t - t.seen < 0.01)
    const losEnemies = enemies.filter((e) => e.los)

    // threat estimate (enemies that can shoot me now)
    let threatDps = 0
    for (const e of losEnemies) threatDps += this.estDps(e.weapons, d3(e.pos, pos))
    let myDps = 0
    const myW = me.weapons.filter((w) => w).map((w) => w!.kind)

    // choose a target
    // endgame: last two circles. Head for the final center; in the last stretch don't start fights, so HP
    // is full when the circle closes (no regen, 260 HP/s for everyone, last HP standing wins)
    const endgame = K.endgame && o.zone.next_radius <= 25.01 && o.zone.radius <= 70.01
    this.quiet = endgame && (o.zone.next_radius < 0.01 || o.t > o.zone.shrink_start + 10)
    let target = this.chooseTarget(o, losEnemies, enemies)
    if (this.quiet && target && o.t - target.lastDmgToMe > 2 && d3(target.pos, pos) > 30) target = null
    this.endgame = endgame
    if (target) myDps = this.estDps(myW, d3(target.pos, pos))

    // fight or flight
    const dpsIn = this.recentDps(o, 3)
    let flee = false
    if (target || dpsIn > 0) {
      const effThreat = Math.max(threatDps, dpsIn * 1.1)
      const ttkMe = me.hp / Math.max(1, effThreat)
      const tHp = target ? target.hp : 1400
      const ttkThem = tHp / Math.max(1, myDps * 0.8)
      const nThreats = losEnemies.length
      if (hpFrac < 0.3 && ttkThem > ttkMe * 0.6) flee = true
      else if (ttkThem > ttkMe * 1.3 && hpFrac < (K.aggro2 ? 0.45 : 0.75)) flee = true
      else if (nThreats >= 3 && hpFrac < (K.aggro2 ? 0.6 : 0.85)) flee = true
      if (target && target.hp < 250 && ttkThem < ttkMe) flee = false
    }
    // outnumbered: avoid open fights with two or more shooters
    const nLos = losEnemies.filter((e) => d3(e.pos, pos) < 230).length
    if (nLos >= 2) {
      let weakest = Infinity
      for (const e of losEnemies) weakest = Math.min(weakest, e.hp)
      if (!(weakest < 350 && hpFrac > 0.5) && !(K.aggro && hpFrac > 0.6)) flee = true
    }
    // gun-only: don't start long-range trades; break line of sight and keep looting
    if (K.gunAvoid && !me.weapons[1] && target && d3(target.pos, pos) > 100 && o.t - this.lastDamagedT > 1.5 && target.hp > 500) flee = true
    // cornered at close range by a single enemy we can beat: fight
    if (flee && nLos === 1 && target && target.los && d3(target.pos, pos) < 40 && target.hp < me.hp * 1.4) flee = false
    if (flee) this.hideUntil = Math.max(this.hideUntil, o.t + 4)
    // stay hidden while regenerating
    if (o.t < this.hideUntil + 8 && hpFrac < (K.aggro2 ? 0.7 : 0.85) && !(nLos === 1 && target && d3(target.pos, pos) < 40)) {
      if (this.lastHideT > o.t - 0.2) this.hideUntil = Math.max(this.hideUntil, o.t + 0.2)
    }
    this.fdbg = `thr${threatDps.toFixed(0)} in${dpsIn.toFixed(0)} my${myDps.toFixed(0)} th${target ? target.hp.toFixed(0) : '-'} flee${flee ? 1 : 0}`

    // ------------- movement -------------
    let moveSet = false
    let lookYaw: number | null = null
    const zone = this.safeCircle(o)
    const zoneNow = this.zoneAt(o, o.t + 4)
    const dZoneNow = d2(pos, zoneNow.c)
    const outside = dZoneNow > zoneNow.r - 3
    const timeToShrink = o.zone.shrink_start - o.t
    const dNext = d2(pos, zone.c)
    const needRotate = dNext > zone.r && (timeToShrink < (dNext - zone.r) / 10 + 20 || o.zone.radius - o.zone.next_radius < 1 || o.t > o.zone.shrink_start)

    // threats for hiding: last known positions
    const threatPts: V3[] = []
    for (const e of remembered) if (o.t - e.seen < 8) threatPts.push([e.pos[0] + e.vel[0] * 0.5, e.pos[1] + e.vel[1] * 0.5, e.pos[2] + 8])
    // unseen attackers: put a ghost along the damage bearing
    for (const e of this.dmgEvents) {
      if (o.t - e.t > 3 || e.bearing === null || e.weapon === "zone") continue
      if (e.by !== null && this.tracks.has(e.by) && o.t - this.tracks.get(e.by)!.seen < 3) continue
      const dist = e.weapon === "lightning" ? 35 : e.weapon === "npc" ? 40 : 110
      threatPts.push([pos[0] + Math.cos(e.bearing) * dist, pos[1] + Math.sin(e.bearing) * dist, pos[2] + 8])
    }

    const hiding = o.t < this.hideUntil || (hpFrac < 0.45 && o.t - this.lastDamagedT < 6 && threatPts.length > 0)
    let label = ""

    if (outside || (needRotate && !target)) {
      // zone first
      const g = this.zoneGoal(o)
      this.goTo(o, g, act)
      act.boost = act.boost || ((outside && me.energy > 30) || me.energy > 60)
      moveSet = true
      label = "zone"
    }

    if (!moveSet && hiding && threatPts.length) {
      _t0 = performance.now()
      const cover = this.findCover(o, threatPts)
      lap('cover', _t0)
      if (cover) {
        this.goTo(o, cover, act)
        if (me.energy > 25) act.boost = true
        label = "hide"
        moveSet = true
        // in cover: stand still (silent), keep aim at threats
        if (Math.hypot(cover.x - pos[0], cover.y - pos[1]) < 2.5) { act.move = [0, 0]; act.boost = false; label = "cover" }
        this.lastHideT = o.t
      } else if ((losEnemies.length || o.t - this.lastDamagedT < 2) && !(K.evadeFight && target && target.los)) {
        // no cover nearby: run away from the threats, inside the zone
        let ax = 0, ay = 0
        for (const tp of threatPts) { const dx = pos[0] - tp[0], dy = pos[1] - tp[1], L = Math.hypot(dx, dy) || 1; ax += dx / L / Math.max(30, L); ay += dy / L / Math.max(30, L) }
        const L = Math.hypot(ax, ay) || 1
        ax /= L; ay /= L
        const z = this.safeCircle(o)
        let gx = pos[0] + ax * 70, gy = pos[1] + ay * 70
        const dz = Math.hypot(gx - z.c[0], gy - z.c[1])
        if (dz > z.r) { gx = z.c[0] + ((gx - z.c[0]) * z.r) / dz; gy = z.c[1] + ((gy - z.c[1]) * z.r) / dz }
        // never run into a map edge
        gx = clamp(gx, this.W.minX + 30, this.W.minX + this.W.nx - 30); gy = clamp(gy, this.W.minY + 30, this.W.minY + this.W.ny - 30)
        this.goTo(o, { x: gx, y: gy, why: "evade" }, act)
        if (me.energy > 20) act.boost = true
        label = "evade"
        moveSet = true
        this.lastHideT = o.t
      }
    }

    // peek combat: step behind nearby cover while we can't shoot back or a big hit is coming
    if (!moveSet && (K.duck || DUCKL) && target && target.los && d3(target.pos, pos) > 25) {
      const gunW = this.weapon(o, "gun")
      const lzW = this.weapon(o, "laser")
      const ltW = this.weapon(o, "lightning")
      const myCharging = !!lzW && (lzW.charge ?? 0) > 0
      const laserReady = !!lzW && (lzW.cooldown ?? 0) < 0.3 && o.t > this.shortUntil
      const lightningOn = !!ltW && d3(target.pos, pos) < (ltW.stats.range ?? 45) - 3
      const reloading = !!gunW && (gunW.reload ?? 0) > 0.4 && !laserReady && !lightningOn
      const laserAtMe = losEnemies.some((e) => e.charging && Math.abs(wrap(e.aim[0] - Math.atan2(pos[1] - e.pos[1], pos[0] - e.pos[0]))) < 0.12)
      let burst = 0
      for (const e of this.dmgEvents) if (o.t - e.t <= 1.0 && e.weapon !== "zone") burst += e.amt
      if ((DUCKL ? laserAtMe : (reloading || laserAtMe || burst > 140)) && !myCharging) {
        const ds = this.duckSpot(o, target, losEnemies)
        if (ds) {
          if (o.t - this.duckT > 1) this.peekPos = [pos[0], pos[1], pos[2]]
          this.duckT = o.t
          this.peekTid = target.id
          this.goTo(o, ds, act)
          if (me.energy > 15) act.boost = true
          if (Math.hypot(ds.x - pos[0], ds.y - pos[1]) < 2.5) { act.move = [0, 0]; act.boost = false }
          label = "duck"
          moveSet = true
        }
      }
    }
    // after ducking: step back out to where we had a line on the target
    if (!moveSet && (K.duck || DUCKL) && this.peekPos && o.t - this.duckT < 4 && o.t - this.duckT > (DUCKL ? 0.8 : 0.15) && hpFrac > 0.3) {
      const pt = this.tracks.get(this.peekTid)
      const reloadingNow = !DUCKL && (this.weapon(o, "gun")?.reload ?? 0) > 0.4 && !this.weapon(o, "laser")
      if (pt && o.t - pt.seen < 5 && !(target && target.los)) {
        if (reloadingNow) { act.move = [0, 0]; label = "ducked"; this.duckT = o.t }
        else { this.goTo(o, { x: this.peekPos[0], y: this.peekPos[1], z: this.peekPos[2], why: "peek" }, act); label = "peek" }
        moveSet = true
      }
    }
    if (target && target.los) this.duckT = Math.min(this.duckT, o.t - 0.15) // seen again: peek done
    if (!moveSet && target) {
      _t0 = performance.now()
      this.combatMove(o, target, act)
      lap('cmove', _t0)
      moveSet = true
      label = (this.fightLooting ? "floot " : this.chasing ? "chase " : "fight ") + target.id
    }

    const canHunt = K.hunt && hpFrac > 0.75 && !needRotate && o.t - this.lastDamagedT > 3
    if (!moveSet && canHunt && me.weapons[1]) {
      const hg = this.huntGoal(o)
      if (hg) { this.goTo(o, hg, act); label = "hunt"; moveSet = true; if (me.energy > 60) act.boost = true }
    }
    if (!moveSet) {
      // loot / drops / npcs / roam
      _t0 = performance.now()
      const lg = this.quiet ? null : this.lootGoal(o, K.farm3 ? enemies.some((e) => d3(e.pos, pos) < 140) || o.t - this.lastDamagedT < 4 : enemies.length > 0)
      lap('loot', _t0)
      if (lg) {
        this.goTo(o, lg, act)
        label = lg.why
        if (lg.why === "crate") lookYaw = Math.atan2(lg.y - pos[1], lg.x - pos[0])
        moveSet = true
        if (needRotate || (lg.why === "drop" && me.energy > 50)) act.boost = true
        // travel fast while calm: energy is otherwise idle (keep a reserve for climbing / fights)
        if (K.calmBoost && me.energy > 50 && !lg.why.endsWith("-shoot") && lg.why !== "capture") act.boost = true
      }
    }
    if (!moveSet && canHunt) {
      const hg = this.huntGoal(o)
      if (hg) { this.goTo(o, hg, act); label = "hunt"; moveSet = true; if (me.energy > 60) act.boost = true }
    }
    if (!moveSet) {
      const g = this.idleGoal(o)
      this.goTo(o, g, act)
      label = "roam"
      if (needRotate) act.boost = true
    }

    // ------------- unstick -------------
    this.unstick(o, act)

    // ------------- dodge projectiles -------------
    _t0 = performance.now()
    this.dodge(o, act)
    lap('dodge', _t0)

    // ------------- aim & fire -------------
    _t0 = performance.now()
    this.aimAndFire(o, act, target, enemies, visibleNpcs, lookYaw)
    lap('aim', _t0)

    // ------------- loot take -------------
    this.takeLoot(o, act)

    // reload when idle
    const gun = me.weapons[0]?.kind === "gun" ? me.weapons[0] : me.weapons[1]?.kind === "gun" ? me.weapons[1] : null
    if (gun && (gun.ammo ?? 1) < (gun.stats.mag ?? 12) && (gun.reload ?? 0) === 0 && !target && (gun.ammo ?? 1) < 6 && o.t - this.lastDamagedT > 2) act.reload = true
    if (gun && gun.ammo === 0 && (gun.reload ?? 0) === 0) act.reload = true

    // waiting at a wall for climb energy: never boost (boost drains the energy we are waiting for)
    if (o.t - this.climbWaitT < 0.25 && me.grounded) act.boost = false
    // never boost on the ground with very low energy (keep reserve to climb out)
    if (act.boost && me.grounded && me.energy < 12 && !outside) act.boost = false

    this.dbg = `${label} ${this.fdbg} hp${me.hp.toFixed(0)} e${me.energy.toFixed(0)} ${this.elapsed().toFixed(1)}ms`
    draw.label(this.dbg.slice(0, 78))
    this.lastPos = [pos[0], pos[1], pos[2]]
    return act
  }

  chooseTarget(o: Observation, losEnemies: Track[], enemies: Track[]): Track | null {
    const me = o.self
    let best: Track | null = null, bs = -Infinity
    // nobody in sight: close tracked mechs, and (finish2) hurt ones further out that went to heal
    const pool = losEnemies.length ? losEnemies : enemies.filter((e) => d3(e.pos, me.pos) < 60 || (K.finish2 && e.hp < e.maxHp * 0.5 && d3(e.pos, me.pos) < 230 && me.hp > me.max_hp * 0.5))
    for (const e of pool) {
      const d = d3(e.pos, me.pos)
      if (d > 300) continue
      let s = -d * 0.5 - e.hp * (K.focus ? 0.35 : 0.15)
      if (K.focus && e.id === this.lastTargetId && o.t - this.lastTargetT < 1.5) s += 90 // stick with it: split damage kills nothing
      if (o.t - e.lastDmgToMe < 3) s += 120
      if (e.los) s += 80
      if (e.weapons.includes("lightning") && d < 60) s += 60
      if (K.rear && losEnemies.length > 1) {
        // facing this one puts the others behind us (rear hits deal 1.5x): prefer the target that keeps them in front
        const a0 = Math.atan2(e.pos[1] - me.pos[1], e.pos[0] - me.pos[0])
        for (const f of losEnemies) {
          if (f.id === e.id || d3(f.pos, me.pos) > 230) continue
          const af = Math.atan2(f.pos[1] - me.pos[1], f.pos[0] - me.pos[0])
          if (Math.abs(wrap(af - a0)) > Math.PI / 2 - 0.15) s -= f.charging ? 70 : 40
        }
      }
      if (s > bs) { bs = s; best = e }
    }
    if (best) { this.lastTargetId = best.id; this.lastTargetT = o.t }
    return best
  }

  pickUpgrade(o: Observation): number {
    const ch = o.offer!.choices
    let best = 0, bs = Infinity
    const mine = new Set(o.self.weapons.filter((w) => w).map((w) => w!.kind))
    for (let i = 0; i < ch.length; i++) {
      let r = UPGRADE_PREF.indexOf(ch[i].id)
      if (r < 0) r = 50
      if (K.endgame && o.t > 240) { const l = LATE_PREF.indexOf(ch[i].id); if (l >= 0) r = l - 10 }
      const def = (this.C.upgrades as any[]).find((u) => u.id === ch[i].id)
      if (def?.requires && !mine.has(def.requires)) r += 40
      if (r < bs) { bs = r; best = i }
    }
    return best
  }

  zoneGoal(o: Observation): Goal {
    const me = o.self
    const z = this.safeCircle(o)
    const c = z.c
    const d = d2(me.pos, c)
    // aim for a point inside the safe circle on our side (the exact final center in the endgame)
    const r = this.endgame ? (o.zone.next_radius < 0.01 ? 0 : 3) : Math.max(0, z.r * 0.6)
    if (d <= r || d < 1) return { x: c[0], y: c[1], why: "zone" }
    const f = (d - r) / d
    return { x: me.pos[0] + (c[0] - me.pos[0]) * f, y: me.pos[1] + (c[1] - me.pos[1]) * f, why: "zone" }
  }

  huntMem: { x: number; y: number; t: number } | null = null
  /** where to go looking for a fight: newest remembered enemy, else the latest combat sound */
  huntGoal(o: Observation): Goal | null {
    const me = o.self, pos = me.pos
    let best: Track | null = null
    for (const e of this.tracks.values()) if (e.id !== me.id && o.t - e.seen < 20 && (!best || e.seen > best.seen)) best = e
    let gx: number | null = null, gy = 0
    if (best) { gx = best.pos[0]; gy = best.pos[1] }
    else {
      const kinds = ["gun", "laser", "lightning", "mortar", "explosion", "boost", "step", "reload", "laser_charge"]
      const loud = this.heard.filter((s) => kinds.includes(s.kind) && o.t - s.t < 4)
      if (loud.length) {
        const s = loud[loud.length - 1]
        const d = s.dist === "near" ? 40 : s.dist === "mid" ? 110 : 200
        gx = pos[0] + Math.cos(s.bearing) * d; gy = pos[1] + Math.sin(s.bearing) * d
      }
    }
    if (gx !== null) this.huntMem = { x: gx, y: gy, t: o.t }
    const h = this.huntMem
    if (!h || o.t - h.t > 15) return null
    if (Math.hypot(h.x - pos[0], h.y - pos[1]) < 8) { this.huntMem = null; return null }
    const z = this.safeCircle(o)
    let x = h.x, y = h.y
    const dz = Math.hypot(x - z.c[0], y - z.c[1])
    if (dz > z.r) { x = z.c[0] + ((x - z.c[0]) * z.r) / dz; y = z.c[1] + ((y - z.c[1]) * z.r) / dz }
    return { x, y, why: "hunt" }
  }

  idleGoal(o: Observation): Goal {
    // hold a spot with cover inside the safe circle; drift toward the next center
    const me = o.self
    const z = this.safeCircle(o)
    const d = d2(me.pos, z.c)
    if (this.stealthy(o) && !this.endgame && d < z.r * 0.75) {
      // sit where the squad's last known positions can't see us (standing still is silent)
      const th: V3[] = []
      const ts = [...this.tracks.values()].filter((e) => e.id !== me.id && o.t - e.seen < 60).sort((a, b) => b.seen - a.seen).slice(0, 4)
      for (const e of ts) th.push([e.pos[0], e.pos[1], e.pos[2] + 8])
      if (th.length) {
        const c = this.findCover(o, th)
        if (c) return { ...c, why: "lurk" }
      }
    }
    if (d < z.r * 0.5) {
      // stay put near walls (cover): find node with low clearance nearby
      return { x: me.pos[0], y: me.pos[1], why: "hold" }
    }
    return this.zoneGoal(o)
  }

  duckT = -99
  peekPos: V3 | null = null
  peekTid = -1
  duckCache: { g: Goal | null; t: number; tid: number } | null = null
  /** a spot within ~30 m of path that the target (and other shooters) cannot see */
  duckSpot(o: Observation, tg: Track, shooters: Track[]): Goal | null {
    const me = o.self
    const W = this.W
    const hc = 4.5 * (1 + 0.05 * me.cubes), ht = 9 * (1 + 0.05 * me.cubes) - 0.3
    const threats: V3[] = []
    for (const e of [tg, ...shooters.filter((s) => s.id !== tg.id)].slice(0, 3)) threats.push([e.pos[0], e.pos[1], e.pos[2] + 8 * (1 + 0.05 * e.cubes)])
    const c = this.duckCache
    if (c && c.tid === tg.id && o.t - c.t < 0.5) return c.g
    if (c && c.g && c.tid === tg.id && o.t - c.t < 4 && this.hiddenAt(c.g.x, c.g.y, c.g.z ?? 0, threats, hc, ht)) { c.t = o.t; return c.g }
    const s = W.freeNode(me.pos[0], me.pos[1], 10, me.pos[2])
    if (s < 0) return null
    const zc = this.zoneAt(o, o.t + 10)
    let evals = 0
    const p = W.nearestWhere(s, DUCKL ? 12 : 32, (n) => {
      if (W.gClear[n] > 5 && n % 3 !== 0) return false
      const x = W.nodeX(n), y = W.nodeY(n)
      if (Math.hypot(x - zc.c[0], y - zc.c[1]) > zc.r - 5) return false
      if (++evals > 160) return true
      return this.hiddenAt(x, y, W.gH[n], threats, hc, ht)
    }, null, 1.2, 2500, this.startMs + 20)
    let g: Goal | null = null
    if (p && p.length && evals <= 160) { const n = p[p.length - 1]; g = { x: W.nodeX(n), y: W.nodeY(n), z: W.gH[n], why: "duck" } }
    this.duckCache = { g, t: o.t, tid: tg.id }
    return g
  }
  coverCache: { g: Goal; t: number } | null = null
  hiddenAt(x: number, y: number, h: number, threats: V3[], hc: number, ht: number): boolean {
    const W = this.W
    for (const t of threats) {
      if (Math.hypot(t[0] - x, t[1] - y) < 12) return false
      if (W.los(t, [x, y, h + ht], 0.5, 1.6)) return false
      if (W.los(t, [x, y, h + hc], 0.5, 1.6)) return false
    }
    return true
  }
  findCover(o: Observation, threats: V3[]): Goal | null {
    const me = o.self
    const W = this.W
    const hc = 4.5 * (1 + 0.05 * me.cubes), ht = 9 * (1 + 0.05 * me.cubes) - 0.3
    const zc = this.zoneAt(o, o.t + 15)
    // reuse the previous spot while it is still hidden
    const cc = this.coverCache
    if (cc && o.t - cc.t < 6 && Math.hypot(cc.g.x - zc.c[0], cc.g.y - zc.c[1]) < zc.r - 5) {
      if (o.t - cc.t < 0.5 || this.hiddenAt(cc.g.x, cc.g.y, cc.g.z ?? 0, threats, hc, ht)) return cc.g
    }
    const s = W.freeNode(me.pos[0], me.pos[1], 10, me.pos[2])
    if (s < 0) return null
    let evals = 0
    const p = W.nearestWhere(s, 130, (n) => {
      const x = W.nodeX(n), y = W.nodeY(n), h = W.gH[n]
      if (W.gClear[n] > 5 && (n % 7) !== 0) return false
      if (Math.hypot(x - zc.c[0], y - zc.c[1]) > zc.r - 5) return false
      if (++evals > 420) return true // out of evaluations: take what we have (we keep moving)
      return this.hiddenAt(x, y, h, threats, hc, ht)
    }, (n) => {
      // prefer moving away from threats
      const x = W.nodeX(n), y = W.nodeY(n)
      let pen = 0
      for (const t of threats) { const dd = Math.hypot(t[0] - x, t[1] - y); if (dd < 50) pen += (50 - dd) / 15 }
      return pen
    }, 1.2, 9000, this.startMs + 26)
    if (!p || p.length === 0 || evals > 420) { this.coverCache = null; return null }
    const n = p[p.length - 1]
    const g = { x: W.nodeX(n), y: W.nodeY(n), z: W.gH[n], why: "cover" }
    this.coverCache = { g, t: o.t }
    return g
  }

  combatMove(o: Observation, tg: Track, act: Action) {
    const me = o.self
    const pos = me.pos
    const W = this.W
    if (K.fightLoot) {
      const g = this.fightLootGoal(o, tg)
      if (g) {
        this.goTo(o, g, act)
        act.boost = me.energy > 35 && !((this.weapon(o, "laser")?.charge ?? 0) > 0)
        this.fightLooting = true
        return
      }
    }
    this.fightLooting = false
    this.chasing = false
    // a hurt enemy broke line of sight to regenerate (45 HP/s after 5 s): we still track it, go finish it
    if (K.finish && !tg.los && o.t - tg.seen < 4.5 && tg.hp < tg.maxHp * (K.finish2 ? 0.5 : 0.45) && me.hp > me.max_hp * 0.5 && d2(tg.pos, pos) < 230) {
      const zc = this.zoneAt(o, o.t + 10)
      if (Math.hypot(tg.pos[0] - zc.c[0], tg.pos[1] - zc.c[1]) < zc.r - 5) {
        this.goTo(o, { x: tg.pos[0], y: tg.pos[1], z: tg.pos[2], why: "chase" }, act)
        act.boost = me.energy > 30
        this.chasing = true
        return
      }
    }
    const d = d2(tg.pos, pos)
    const has = (k: string) => !!this.weapon(o, k)
    // preferred distance band
    let lo = 35, hi = 110
    if (has("laser")) {
      if (K.laserBand && !tg.weapons.some((w) => w !== "gun")) { lo = 150; hi = 195 } else { lo = 60; hi = 160 }
    }
    if (has("lightning")) { lo = 15; hi = 38 }
    if (tg.weapons.includes("lightning") && !has("lightning")) lo = Math.max(lo, 60)
    if (tg.weapons.includes("mortar") && !has("lightning")) lo = Math.max(lo, 40)
    if (o.t > this.strafeUntil) {
      if (DODGE === 1) { this.strafe = -this.strafe || 1; this.strafeUntil = o.t + 0.25 + this.rnd() * 0.3 }
      else if (DODGE === 2) { this.strafe = -this.strafe || 1; this.strafeUntil = o.t + 0.5 + this.rnd() * 0.4 }
      else { this.strafe = this.rnd() < 0.5 ? -1 : 1; this.strafeUntil = o.t + 0.35 + this.rnd() * 0.7 }
    }
    const ux = (tg.pos[0] - pos[0]) / Math.max(1, d), uy = (tg.pos[1] - pos[1]) / Math.max(1, d)
    let radial = 0
    if (d < lo) radial = -1
    else if (d > hi) radial = 1
    else radial = 0
    if (!tg.los && d < 250) radial = 0.4 // close in to regain sight? mild
    if (K.focus && tg.hp < 350 && me.hp > tg.hp * 1.5 && d > 25) radial = 1 // finish it before it regenerates
    let mx = -uy * this.strafe + ux * radial * 0.8
    let my = ux * this.strafe + uy * radial * 0.8
    // check walkability ahead; flip strafe if blocked
    const L = Math.hypot(mx, my) || 1
    mx /= L; my /= L
    const ahead = W.node(pos[0] + mx * 5, pos[1] + my * 5)
    const z = this.zoneAt(o, o.t + 5)
    const outAhead = Math.hypot(pos[0] + mx * 8 - z.c[0], pos[1] + my * 8 - z.c[1]) > z.r - 4
    if (W.gBlocked[ahead] || outAhead) {
      this.strafe = -this.strafe
      this.strafeUntil = o.t + 0.6
      mx = -uy * this.strafe + ux * radial * 0.8
      my = ux * this.strafe + uy * radial * 0.8
      const ahead2 = W.node(pos[0] + mx * 5, pos[1] + my * 5)
      if (W.gBlocked[ahead2]) { mx = ux * radial; my = uy * radial }
      if (outAhead) { const zx = z.c[0] - pos[0], zy = z.c[1] - pos[1], zl = Math.hypot(zx, zy) || 1; mx = zx / zl; my = zy / zl }
    }
    act.move = [mx, my]
    const charging = (this.weapon(o, "laser")?.charge ?? 0) > 0
    act.boost = me.energy > (DODGE > 0 && BOOSTLOW ? 15 : 35) && !charging
  }

  cubeMem = new Map<number, { id: number; pos: V3; t: number }>()
  pickMem = new Map<number, { id: number; kind: string; pos: V3; t: number }>()
  crateMem = new Map<number, { id: number; pos: V3; t: number }>()
  /** remember loot we saw (it is only listed while visible); forget what should be visible but isn't */
  updateLootMem(o: Observation) {
    const me = o.self
    const eye: V3 = [me.pos[0], me.pos[1], me.pos[2] + (me.stats.eye_height ?? 8)]
    const near = (this.C.vision.near_range ?? 45) + (me.stats.near_range_bonus ?? 0) - 3
    for (const c of o.cubes) this.cubeMem.set(c.id, { id: c.id, pos: c.pos, t: o.t })
    for (const p of o.pickups) this.pickMem.set(p.id, { id: p.id, kind: p.kind, pos: p.pos, t: o.t })
    if (K.crateMem) for (const c of o.crates) this.crateMem.set(c.id, { id: c.id, pos: c.pos, t: o.t })
    const prune = (m: Map<number, any>) => {
      for (const [id, c] of m) {
        if (c.t === o.t) continue
        const dd = d2(c.pos, me.pos)
        if (o.t - c.t > 45 || (dd < 2.5 && Math.abs(c.pos[2] - me.pos[2]) < 4)) { m.delete(id); continue }
        if (dd < near && this.W.los(eye, [c.pos[0], c.pos[1], c.pos[2] + 0.5], 0.5)) m.delete(id) // should see it: gone
      }
    }
    prune(this.cubeMem)
    prune(this.pickMem)
    // crates never move: keep them long, drop them once we should see them and don't (destroyed)
    for (const [id, c] of this.crateMem) {
      if (c.t === o.t) continue
      if (o.t - c.t > 200) { this.crateMem.delete(id); continue }
      if (d2(c.pos, me.pos) < near && (this.W.los(eye, [c.pos[0], c.pos[1], c.pos[2] + 1.2], 0.5) || this.W.los(eye, [c.pos[0], c.pos[1], c.pos[2] + 2.3], 0.5))) this.crateMem.delete(id)
    }
  }

  /** in a fight: a cube or better weapon close enough to walk to while we keep shooting */
  fightLootGoal(o: Observation, tg: Track): Goal | null {
    const me = o.self, pos = me.pos
    const zc = this.zoneAt(o, o.t + 10)
    const ok = (p: number[]) => Math.hypot(p[0] - zc.c[0], p[1] - zc.c[1]) < zc.r - 5 && Math.abs(p[2] - me.pos[2]) < 6
    let best: Goal | null = null, bd = Infinity
    if (K.drops) {
      for (const dr of o.drops) {
        if ((this.dropFail.get(dr.id) ?? -1) > o.t) continue
        if (dr.holder !== null && dr.holder !== me.id && dr.progress > 1) continue
        const d = d2(dr.pos, pos)
        if (d > 150 || dr.lands_in > d / 15 + 3) continue
        if (Math.hypot(dr.pos[0] - zc.c[0], dr.pos[1] - zc.c[1]) > zc.r - 5) continue
        let crowd = false
        for (const e of this.tracks.values()) if (e.id !== me.id && o.t - e.seen < 3 && d2(e.pos, dr.pos) < 25) crowd = true
        if (crowd) continue
        // 3 cubes + full HP + full energy: worth far more than a loose cube
        if (d - 100 < bd) { bd = d - 100; best = { x: dr.pos[0], y: dr.pos[1], z: dr.pos[2], why: "fdrop", id: dr.id } }
      }
    }
    const capped = K.capCubes && me.cubes >= (this.C.cubes.stat_cap ?? 10)
    for (const c of this.cubeMem.values()) {
      if (capped) break
      if ((this.badTargets.get(c.id) ?? -1) > o.t || !ok(c.pos)) continue
      const d = d2(c.pos, pos)
      if (d < (K.loot3 ? 80 : K.loot2 ? 55 : 35) && d < bd) { bd = d; best = { x: c.pos[0], y: c.pos[1], z: c.pos[2], why: "fcube", id: c.id } }
    }
    const myBest = Math.max(0, ...me.weapons.filter((w) => w && w.kind !== "gun").map((w) => WEAPON_VALUE[w!.kind] ?? 0))
    for (const p of this.pickMem.values()) {
      const v = WEAPON_VALUE[p.kind] ?? 0
      if (v <= 0 || this.weapon(o, p.kind) || (me.weapons[1] && v <= myBest + 0.4)) continue
      if ((this.badTargets.get(p.id) ?? -1) > o.t || !ok(p.pos)) continue
      const d = d2(p.pos, pos) - 10 // weapons are worth a little detour
      if (d < (K.loot3 ? 55 : K.loot2 ? 40 : 30) && d < bd) { bd = d; best = { x: p.pos[0], y: p.pos[1], z: p.pos[2], why: "fweapon", id: p.id } }
    }
    // don't walk into a lightning arc
    if (best && tg.weapons.includes("lightning") && Math.hypot(best.x - tg.pos[0], best.y - tg.pos[1]) < 50) return null
    return best
  }

  lootGoal(o: Observation, enemiesSeen: boolean): Goal | null {
    const farm = K.farm && o.t < (K.farm2 ? 200 : 120)
    const me = o.self
    const pos = me.pos
    const z = this.safeCircle(o)
    const early = o.zone.shrink_start - o.t > 25
    const okPlace = (p: number[]) => {
      if (d2(p, z.c) < z.r) return true
      const zn = this.zoneAt(o, o.t + 20)
      return early && d2(p, zn.c) < zn.r - 25
    }
    const cands: { g: Goal; score: number }[] = []
    const hasSlot1 = !!me.weapons[1]
    const myBest = Math.max(...me.weapons.filter((w) => w && w.kind !== "gun").map((w) => WEAPON_VALUE[w!.kind] ?? 0), 0)
    for (const p of this.pickMem.values()) {
      if ((this.badTargets.get(p.id) ?? -1) > o.t) continue
      const v = WEAPON_VALUE[p.kind] ?? 0
      if (v <= 0) continue
      if (this.weapon(o, p.kind)) continue
      if (hasSlot1 && v <= myBest) continue
      if (!okPlace(p.pos)) continue
      const dist = d3(p.pos, pos)
      const climb = Math.max(0, p.pos[2] - this.W.surfAt(pos[0], pos[1]))
      cands.push({ g: { x: p.pos[0], y: p.pos[1], z: p.pos[2], why: "weapon", id: p.id }, score: v * 60 + (hasSlot1 ? 0 : 60) - dist - climb * 2 })
    }
    for (const c of this.cubeMem.values()) {
      if ((this.badTargets.get(c.id) ?? -1) > o.t) continue
      if (!okPlace(c.pos)) continue
      const dist = d3(c.pos, pos)
      cands.push({ g: { x: c.pos[0], y: c.pos[1], z: c.pos[2], why: "cube", id: c.id }, score: (K.capCubes && me.cubes >= (this.C.cubes.stat_cap ?? 10) ? 0 : farm ? 200 : K.loot3 ? 150 : 70) - dist })
    }
    // crates: approach to shooting range if not visible line
    for (const c of (K.crateMem ? this.crateMem.values() : o.crates)) {
      if (this.regenHold(o)) break
      if ((this.badTargets.get(c.id) ?? -1) > o.t) continue
      if (!okPlace(c.pos)) continue
      const dist = d3(c.pos, pos)
      if (dist > (farm ? 220 : 160)) continue
      cands.push({ g: { x: c.pos[0], y: c.pos[1], z: c.pos[2], why: "crate", id: c.id }, score: farm ? 90 - dist * 0.6 : 35 - dist })
    }
    // NPC drones for cubes (if healthy)
    if (me.hp / me.max_hp > (farm ? 0.45 : 0.55) && !enemiesSeen && !this.regenHold(o)) {
      for (const n of this.npcs.values()) {
        if (o.t - n.seen > 4) continue
        if (!okPlace(n.pos)) continue
        const dist = d3(n.pos, pos)
        if (dist > (farm ? 260 : 180)) continue
        cands.push({ g: { x: n.pos[0], y: n.pos[1], z: n.pos[2], why: "npc", id: n.id }, score: farm ? 170 - dist * 0.6 : 45 - dist })
      }
    }
    // supply drops
    for (const dr of o.drops) {
      if ((this.dropFail.get(dr.id) ?? -1) > o.t) continue
      const dist = d2(dr.pos, pos)
      if (dist > (K.drops ? 450 : 220)) continue
      if (dr.holder !== null && dr.holder !== me.id && dr.progress > 1) continue
      let others = 0
      for (const e of this.tracks.values()) if (o.t - e.seen < 3 && d2(e.pos, dr.pos) < 60) others++
      if (others > 0 && me.hp / me.max_hp < 0.8) continue
      const eta = dist / 15
      if (dr.lands_in > eta + 8) continue
      cands.push({ g: { x: dr.pos[0], y: dr.pos[1], z: dr.pos[2], why: "drop", id: dr.id }, score: 150 - dist * 0.6 + (me.hp < me.max_hp * 0.6 ? 60 : 0) })
    }
    if (!cands.length) return null
    cands.sort((a, b) => b.score - a.score)
    const g = cands[0].g
    // crates/npcs: we only need to get within shooting distance with line of sight
    if (g.why === "crate" || g.why === "npc") {
      const d = d3([g.x, g.y, g.z ?? 0], pos)
      const eye: V3 = [pos[0], pos[1], pos[2] + 8]
      const tz = (g.z ?? 0) + 1.2
      const seen = g.why === "npc" || o.crates.some((c) => c.id === g.id)
      if (d < (g.why === "npc" ? 70 : 90) && this.W.los(eye, [g.x, g.y, tz]) && seen) {
        // hold position (strafe a little vs npcs)
        return { x: pos[0], y: pos[1], why: g.why + "-shoot" }
      }
    }
    if (g.why === "drop") {
      const dr = o.drops.find((d) => d.id === g.id)
      if (dr && d2(dr.pos, pos) < (dr.radius ?? 8) - 2.5) return { x: pos[0], y: pos[1], why: "capture" }
    }
    // give up on targets we can't reach
    if (this.path && (this.path as any).partial && this.pathGoal?.id === g.id && o.t - this.pathT < 0.2) {
      const end = this.path[this.path.length - 1]
      if (Math.hypot(this.W.nodeX(end) - g.x, this.W.nodeY(end) - g.y) > 8 && g.id !== undefined) this.badTargets.set(g.id, o.t + 30)
    }
    return g
  }

  /** hurt and out of combat: let the 45 HP/s regen run instead of shooting drones/crates (dealing damage resets it) */
  /** late game: farming noise (gun 320 m) only advertises us to the hunting squad */
  stealthy(o: Observation): boolean { return K.stealth && o.t >= 200 }
  regenHold(o: Observation): boolean {
    const me = o.self
    // a drone shooting at us: fight back
    for (const e of this.dmgEvents) if (o.t - e.t < 2 && e.by !== null && e.by !== undefined && e.by >= 100) return false
    if (this.stealthy(o)) return true
    if (!K.sustain) return false
    return me.hp < me.max_hp * 0.8
  }

  takeLoot(o: Observation, act: Action) {
    const me = o.self
    const reach = this.C.loot.pickup_radius ?? 4
    const myW = me.weapons
    let best: { id: number; v: number; drop?: number } | null = null
    for (const p of o.pickups) {
      if (d2(p.pos, me.pos) > reach - 0.3 || Math.abs(p.pos[2] - me.pos[2]) > 3.8) continue
      if (this.weapon(o, p.kind)) continue
      const v = WEAPON_VALUE[p.kind] ?? 0
      if (v <= 0) continue
      if (!myW[1]) { if (!best || v > best.v) best = { id: p.id, v }; continue }
      if (!myW[0]) { if (!best || v > best.v) best = { id: p.id, v }; continue }
      // both full: swap the non-gun if better
      const s1 = myW[1]!.kind === "gun" ? 0 : 1
      const cur = WEAPON_VALUE[myW[s1]!.kind] ?? 0
      if (v > cur + 0.4 && !(myW[s1]!.kind === "laser" && (myW[s1]!.charge ?? 0) > 0)) {
        if (!best || v > best.v) best = { id: p.id, v, drop: s1 }
      }
    }
    if (best && !(this.lastTake === best.id && o.t - this.lastTakeT < 0.3)) {
      act.take = best.id
      if (best.drop !== undefined) act.drop = best.drop
      this.lastTake = best.id
      this.lastTakeT = o.t
    }
  }

  unstick(o: Observation, act: Action) {
    const me = o.self
    const mv = act.move ?? [0, 0]
    const want = Math.hypot(mv[0], mv[1]) > 0.5
    if (o.t - this.progressT > 1.2) {
      const moved = d2(me.pos, this.progressPos)
      if (want && moved < 2.0 && o.t - this.progressT < 3 && o.t > 1) {
        this.unstickUntil = o.t + 0.8
        this.unstickDir = this.rnd() < 0.5 ? -1 : 1
        this.pathT = -99 // force replan
        if (o.t - this.lastStuckT < 8) this.noClimbUntil = o.t + 6 // repeated: stop trying to climb, find another way
        this.lastStuckT = o.t
      }
      this.progressT = o.t
      this.progressPos = [me.pos[0], me.pos[1], me.pos[2]]
    }
    if (o.t < this.unstickUntil) {
      if (me.grounded) act.jump = true
      else if (me.energy > 10) act.boost = true
      // add a sideways component
      const a = Math.atan2(mv[1], mv[0]) + this.unstickDir * 0.9
      act.move = [Math.cos(a), Math.sin(a)]
    }
  }

  dodge(o: Observation, act: Action) {
    const me = o.self
    const pos = me.pos
    const g = this.C.weapons.mortar.gravity ?? 22
    const sr = (this.C.weapons.mortar.splash_radius ?? 7) + 3.5
    for (const p of o.projectiles) {
      if (p.kind !== "mortar") continue
      // predict impact roughly: when z reaches surface near us
      let x = p.pos[0], y = p.pos[1], z = p.pos[2], vx = p.vel[0], vy = p.vel[1], vz = p.vel[2]
      let hit: V3 | null = null
      for (let s = 0; s < 80; s++) {
        const dt = 0.05
        x += vx * dt; y += vy * dt; z += vz * dt; vz -= g * dt
        if (z < this.W.surfAt(x, y) + 0.2 || this.W.solid(x, y, z)) { hit = [x, y, z]; break }
      }
      if (!hit) continue
      const dd = d2(hit, pos)
      if (dd < sr) {
        let ax = pos[0] - hit[0], ay = pos[1] - hit[1]
        const L = Math.hypot(ax, ay) || 1
        ax /= L; ay /= L
        if (L < 0.5) { ax = -p.vel[1]; ay = p.vel[0]; const l2 = Math.hypot(ax, ay) || 1; ax /= l2; ay /= l2 }
        act.move = [ax, ay]
        act.boost = me.energy > 5
      }
    }
  }

  aimAndFire(o: Observation, act: Action, target: Track | null, enemies: Track[], npcs: Track[], lookYaw: number | null) {
    const me = o.self
    const pos = me.pos
    const W = this.W
    const fire: [boolean, boolean] = [false, false]
    const ws = me.weapons
    const aimNow = me.aim
    let desired: [number, number] | null = null
    const muz = this.muzzle(o)

    // what to shoot: mech target, else npc, else crate
    let tpos: V3 | null = null, tvel: V3 = [0, 0, 0], hOff = 4.5, radius = 2.5, tlos = false, isMech = false
    if (target) {
      const sc = 1 + 0.05 * target.cubes
      tpos = target.pos; tvel = target.vel; hOff = 4.5 * sc; radius = 2.5 * sc; tlos = target.los; isMech = true
    } else if (!this.quiet && !this.regenHold(o)) {
      // npcs in sight
      let bn: Track | null = null, bd = Infinity
      for (const n of npcs) {
        const d = d3(n.pos, pos)
        if (d < bd && n.los && d < 150) { bd = d; bn = n }
      }
      if (bn) { tpos = bn.pos; tvel = bn.vel; hOff = 1.75; radius = 1.8; tlos = true }
      else {
        let bc: any = null, bcd = Infinity
        for (const c of o.crates) {
          const d = d3(c.pos, pos)
          if (d < 110 && d < bcd) {
            const cp: V3 = [c.pos[0], c.pos[1], c.pos[2] + 1.2]
            if (W.los(muz, cp, 0.5)) { bcd = d; bc = c }
          }
        }
        if (bc) { tpos = bc.pos; tvel = [0, 0, 0]; hOff = 1.2; radius = 1.4; tlos = true }
      }
    }

    if (tpos) {
      const gun: number = ws[0]?.kind === "gun" ? 0 : ws[1]?.kind === "gun" ? 1 : -1
      const lz = this.slotOf(o, "laser")
      const lt = this.slotOf(o, "lightning")
      const mo = this.slotOf(o, "mortar")
      const dist = d3(tpos, muz)
      // primary aim: gun lead (or laser direct if charging)
      const gunSpeed = gun >= 0 ? ws[gun]!.stats.speed : 252
      const la = this.leadAim(o, tpos, tvel, gunSpeed, hOff)
      desired = [la.yaw, la.pitch]
      const laserCharging = lz >= 0 && (ws[lz]!.charge ?? 0) > 0
      if (laserCharging || (lz >= 0 && tlos && (ws[lz]!.cooldown ?? 0) <= 0.05 && dist < 260)) {
        const l2 = this.leadAim(o, tpos, tvel, 1e6, hOff)
        if (laserCharging) {
          // keep the gun leading (and firing) through the charge; snap to the beam aim at the end
          const full = ws[lz]!.stats.charge ?? 0.75
          const gunBusy = gun < 0 || (ws[gun]!.reload ?? 0) > 0 || (ws[gun]!.ammo ?? 1) === 0 || !tlos
          if (!K.gunCharge || gunBusy || (ws[lz]!.charge ?? 0) >= full - 0.12) desired = [l2.yaw, l2.pitch]
        }
      }
      const angErr = (y: number, p: number) => Math.hypot(wrap(aimNow[0] - y) * Math.cos(p), aimNow[1] - p)
      const tolFor = (rr: number, dd: number) => Math.max(0.006, Math.atan2(rr * 1.5, Math.max(1, dd)))
      // GUN
      if (gun >= 0 && !tlos) this.fdbg += ' NOLOS'
      if (gun >= 0 && tlos) {
        const w = ws[gun]!
        const err = angErr(la.yaw, la.pitch)
        const ld = d3(la.pt, muz)
        this.fdbg += ` err${err.toFixed(3)} tol${tolFor(radius, ld).toFixed(3)} rl${(w.reload ?? 0).toFixed(1)} los${W.los(muz, la.pt, 2) ? 1 : 0}`
        if (err < tolFor(radius, ld) + 0.002 && ld < (w.stats.range ?? 230) && (w.reload ?? 0) === 0 && (w.ammo ?? 1) > 0) {
          // check the bullet path is clear
          if (W.los(muz, la.pt, 2)) fire[gun] = true
        }
      }
      // LASER
      if (lz >= 0 && o.t > this.shortUntil) {
        const w = ws[lz]!
        const full = w.stats.charge ?? 0.75
        const ch = w.charge ?? 0
        const l2 = this.leadAim(o, tpos, tvel, 1e6, hOff)
        const err = angErr(l2.yaw, l2.pitch)
        const ok = tlos && dist < (w.stats.range ?? 280) - 5 && W.los(muz, l2.pt, 2)
        if (ch > 0) {
          // charging: release when full and on target
          const holdLeft = full + (this.C.weapons.laser.hold_s ?? 2) - ch
          if (ok && ch >= full - 0.02 && err < tolFor(radius, dist)) fire[lz] = false // release
          else if (!ok && holdLeft < 0.25) fire[lz] = false // release before auto-fire anyway
          else if (ok && target && target.hp < 120 && ch > 0.2 && err < tolFor(radius, dist)) fire[lz] = false
          else fire[lz] = true
          if (!ok && ch < full && !target) fire[lz] = false
        } else if (ok && (w.cooldown ?? 0) <= 0.1 && (isMech || o.self.cubes < 10)) {
          fire[lz] = true // start charging
        }
      }
      // LIGHTNING
      if (lt >= 0) {
        const w = ws[lt]!
        const rng = (w.stats.range ?? 45) - 2
        const cone = ((w.stats.cone_deg ?? 30) * PI) / 360
        const yawTo = Math.atan2(tpos[1] - pos[1], tpos[0] - pos[0])
        if (dist < rng && Math.abs(wrap(aimNow[0] - yawTo)) < cone * 0.8 && tlos && me.energy > (w.stats.energy ?? 3) + 4 && (w.cooldown ?? 0) <= 0.1) fire[lt] = true
        if (dist < rng && gun < 0) desired = [yawTo, Math.atan2(tpos[2] + hOff - muz[2], d2(tpos, pos))]
      }
      // MORTAR
      if (mo >= 0 && isMech) {
        const w = ws[mo]!
        const dd = d2(tpos, pos)
        if (dd > 28 && dd < 220 && (w.cooldown ?? 0) <= 0.1) {
          const ma = this.mortarAim(o, tpos, tvel)
          if (ma.ok) {
            const err = angErr(ma.yaw, ma.pitch)
            // only fire when the gun isn't the better use of the aim, or target hidden
            if (!tlos || gun < 0 || (ws[gun]!.reload ?? 0) > 0) {
              desired = [ma.yaw, ma.pitch]
              if (err < 0.03) fire[mo] = true
            }
          }
        }
      }
    }

    if (!desired) {
      // look toward danger: recent damage, then loud sounds, then movement
      let yaw: number | null = lookYaw
      const recent = this.dmgEvents.filter((e) => e.bearing !== null && o.t - e.t < 3 && e.weapon !== "zone")
      if (recent.length) yaw = recent[recent.length - 1].bearing
      else {
        // remembered enemies
        let bt: Track | null = null
        for (const e of enemies) if (!bt || d3(e.pos, pos) < d3(bt.pos, pos)) bt = e
        if (!bt) for (const e of this.tracks.values()) if (o.t - e.seen < 6 && (!bt || e.seen > bt.seen)) bt = e
        if (bt) yaw = Math.atan2(bt.pos[1] - pos[1], bt.pos[0] - pos[0])
        else {
          const loud = this.heard.filter((s) => s.kind !== "step" && s.kind !== "death" && s.kind !== "drop" && s.kind !== "crate" && o.t - s.t < 2 && s.dist !== "far")
          if (loud.length) yaw = loud[loud.length - 1].bearing
        }
      }
      if (yaw === null) {
        const mv = act.move ?? [0, 0]
        if (Math.hypot(mv[0], mv[1]) > 0.3) yaw = Math.atan2(mv[1], mv[0]) + (K.scan ? Math.sin(o.t * 1.6) * 1.2 : 0)
        else yaw = aimNow[0] + 0.6 // slow scan
      }
      desired = [yaw!, 0]
      // laser charging but nothing to shoot: release before auto-fire anyway
      const lz = this.slotOf(o, "laser")
      if (lz >= 0 && (ws[lz]!.charge ?? 0) > 0) fire[lz] = false
    }
    act.aim = [wrap(desired[0]), clamp(desired[1], me.stats.min_pitch ?? -0.7, me.stats.max_pitch ?? 1.3)]
    act.fire = fire
  }
}

export { Brain }
/** used only if the map cannot be loaded: walk to the zone and shoot what we see */
function fallbackBot(hello: Hello) {
  return {
    name: "oval-survivor",
    act(o: Observation) {
      const me = o.self
      const [x, y, z] = me.pos
      const g = o.zone.next_center
      const yaw = Math.atan2(g[1] - y, g[0] - x)
      const act: any = { move: Math.hypot(g[0] - x, g[1] - y) > o.zone.next_radius * 0.5 ? [Math.cos(yaw), Math.sin(yaw)] : [0, 0], aim: [yaw, 0], jump: o.tick % 40 === 0 }
      if (o.offer) act.pick = 0
      const e = o.mechs.filter((m) => m.kind === "mech").sort((a, b) => d3(a.pos, me.pos) - d3(b.pos, me.pos))[0]
      if (e) {
        const tt = d3(e.pos, me.pos) / 252
        const tx = e.pos[0] + e.vel[0] * tt, ty = e.pos[1] + e.vel[1] * tt
        act.aim = [Math.atan2(ty - y, tx - x), Math.atan2(e.pos[2] + 4.5 - z - 7, Math.hypot(tx - x, ty - y))]
        act.fire = [true, true]
      }
      return act
    },
  }
}

if (import.meta.main)
  run((hello: Hello) => {
    try {
      return new Brain(hello)
    } catch (e) {
      log("brain init failed, using fallback", e)
      return fallbackBot(hello)
    }
  })
