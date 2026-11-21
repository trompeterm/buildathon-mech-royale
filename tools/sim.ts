// Approximate local simulator of the mechfight rules (protocol.md) for testing the bot offline.
// Usage: bun tools/sim.ts [matches=8] [seed=1] [--verbose] [--ffa N] (N copies of our bot)
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { Brain, PROF, PROFMAX } from "../src/bot.ts"
import { World, type V3 } from "../src/world.ts"

const HELLO = JSON.parse(gunzipSync(readFileSync("kit/check/stream.jsonl.gz")).toString().split("\n")[0])
const CFG = HELLO.config
const PI = Math.PI
const wrap = (a: number) => { while (a > PI) a -= 2 * PI; while (a < -PI) a += 2 * PI; return a }
const DT = 1 / CFG.match.tick_hz

function rng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const W = new World("kit/arena")

type Wpn = { kind: string; cooldown: number; ammo: number; reload: number; charge: number; stats: any }
const mkW = (kind: string): Wpn => ({ kind, cooldown: 0, ammo: CFG.weapons.gun.mag, reload: 0, charge: 0, stats: { ...CFG.weapons[kind] } })

type Mech = {
  id: number; pos: V3; vel: V3; aim: [number, number]; cmdAim: [number, number]
  hp: number; maxHp: number; energy: number; spendT: number; grounded: boolean
  weapons: [Wpn | null, Wpn | null]; cubes: number; alive: boolean; lastDmgT: number
  ctrl: any; isBot: boolean; tier: number; cmd: any; events: any[]; sounds: any[]; beams: any[]
  seen: Map<number, number>; deathT: number; place: number; kills: number; shortUntil: number
  shots?: number; hits?: number; dealt?: number; stats: any; upgrades: string[]; offer: any; offerQ: number; lastAnswer: number; dmgBy: Map<number, number>; cause: string
}
type Proj = { id: number; kind: string; pos: V3; vel: V3; owner: number; dmg: number; left: number; ttl: number }
type Npc = { id: number; pos: V3; vel: V3; home: V3; hp: number; cd: number; target: number; alive: boolean }

class Match {
  r: () => number
  mechs: Mech[] = []
  projs: Proj[] = []
  npcs: Npc[] = []
  crates: { id: number; pos: V3; hp: number }[] = []
  cubes: { id: number; pos: V3 }[] = []
  pickups: { id: number; kind: string; pos: V3 }[] = []
  drops: { id: number; pos: V3; landT: number; progress: number; holder: number | null; taken: boolean }[] = []
  dropsCalled = 0
  stepDrops() {
    const D = CFG.drops
    if (process.env.SIM_NODROPS) return
    while (this.dropsCalled < D.times.length && this.t >= D.times[this.dropsCalled]) {
      this.drops.push({ id: 20000 + this.dropsCalled, pos: this.randPoint(this.znr * D.spread, this.zn), landT: this.t + D.fall_s, progress: 0, holder: null, taken: false })
      this.dropsCalled++
    }
    for (const d of this.drops) {
      if (d.taken || this.t < d.landT) continue
      const inside = this.mechs.filter((m) => m.alive && Math.hypot(m.pos[0] - d.pos[0], m.pos[1] - d.pos[1]) < D.radius)
      if (inside.length === 0) { d.holder = null; d.progress = 0; continue }
      if (inside.length > 1) continue
      const m = inside[0]
      if (d.holder !== m.id) { d.holder = m.id; d.progress = 0 }
      d.progress += DT
      if (d.progress >= D.capture_s) {
        d.taken = true
        for (let i = 0; i < D.cubes; i++) {
          const before = m.cubes
          m.cubes++
          if (m.cubes <= CFG.cubes.stat_cap) { const add = CFG.mech.hp * CFG.cubes.hp_per_cube; m.maxHp += add; m.hp += add }
          if (CFG.cubes.upgrade_thresholds.some((th: number) => th > before && th <= m.cubes)) this.makeOffer(m)
        }
        m.hp = m.maxHp; m.energy = m.stats.energy
        m.events.push({ type: "drop", id: d.id, cubes: m.cubes })
      }
    }
  }
  nextId = 30000
  t = 0
  tick = 0
  zc: [number, number]; zr: number; phase = -1; zn: [number, number]; znr: number; zs = 0; ze = 0; zdps = 0
  phaseStart = 0
  hunters = 1
  verbose: boolean
  timing: number[] = []
  hist: Record<string, number> = {}
  log: string[] = []

  constructor(seed: number, nBots: number, verbose: boolean) {
    this.r = rng(seed)
    this.verbose = verbose
    this.zc = [...CFG.zone.start_center] as [number, number]
    this.zr = CFG.zone.start_radius
    this.zn = this.zc; this.znr = this.zr
    this.nextPhase()
    // spawns
    const pts: V3[] = []
    while (pts.length < 16) {
      const p = this.randPoint(this.zr * CFG.match.spawn_zone_fraction, this.zc)
      if (pts.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > CFG.match.spawn_min_separation * 0.8) || this.r() < 0.01) pts.push(p)
    }
    for (let i = 0; i < 16; i++) {
      const isBot = i < nBots
      const m: Mech = {
        id: i, pos: pts[i], vel: [0, 0, 0], aim: [this.r() * 6 - 3, 0], cmdAim: [0, 0], hp: CFG.mech.hp, maxHp: CFG.mech.hp,
        energy: CFG.mech.energy, spendT: -9, grounded: true, weapons: [mkW("gun"), null], cubes: 0, alive: true, lastDmgT: -99,
        ctrl: null, isBot, tier: isBot ? -1 : i < nBots + 4 ? 0 : i < nBots + 8 ? 1 : i < nBots + 12 ? 2 : 3, cmd: {}, events: [], sounds: [], beams: [],
        seen: new Map(), deathT: -1, place: 0, kills: 0, shortUntil: -1, stats: { ...CFG.mech }, upgrades: [], offer: null, offerQ: 0, lastAnswer: 0, dmgBy: new Map(), cause: "",
      }
      m.cmdAim = [...m.aim] as [number, number]
      if (isBot) {
        const hello = { ...HELLO, slot: i, seed: seed * 31 + i, map: { dir: "kit/arena", files: [] } }
        m.ctrl = new Brain(hello)
      }
      this.mechs.push(m)
    }
    // loot
    for (let i = 0; i < CFG.loot.floor_count; i++) {
      const k = ["mortar", "laser", "lightning"][Math.floor(this.r() * 3)]
      this.pickups.push({ id: 8000 + i, kind: k, pos: this.randPoint(this.zr * 0.9, this.zc) })
    }
    for (let i = 0; i < CFG.crates.count; i++) this.crates.push({ id: 1000 + i, pos: this.randPoint(this.zr * 0.9, this.zc), hp: CFG.crates.hp })
    for (let i = 0; i < CFG.npc.count; i++) {
      const p = this.randPoint(this.zr * 0.85, this.zc)
      this.npcs.push({ id: 100 + i, pos: p, vel: [0, 0, 0], home: [...p] as V3, hp: CFG.npc.hp, cd: 0, target: -1, alive: true })
    }
  }

  randPoint(r: number, c: [number, number]): V3 {
    for (let k = 0; k < 500; k++) {
      const a = this.r() * 2 * PI, d = Math.sqrt(this.r()) * r
      const x = c[0] + Math.cos(a) * d, y = c[1] + Math.sin(a) * d
      if (!W.inBounds(x, y)) continue
      const n = W.node(x, y)
      if (W.gBlocked[n]) continue
      if (W.surfAt(x, y) - W.groundAt(x, y) > 0.5) continue
      return [x, y, W.surfAt(x, y)]
    }
    return [c[0], c[1], W.surfAt(c[0], c[1])]
  }

  nextPhase() {
    this.phase++
    const ph = CFG.zone.phases[this.phase]
    this.zc = this.zn; this.zr = this.znr
    if (!ph) { this.zs = this.ze = 1e9; return }
    this.zs = this.t + ph.hold_s
    this.ze = this.zs + ph.shrink_s
    const room = this.zr - ph.radius
    const a = this.r() * 2 * PI, d = Math.sqrt(this.r()) * room
    let nc: [number, number] = [this.zc[0] + Math.cos(a) * d, this.zc[1] + Math.sin(a) * d]
    for (let k = 0; k < 30 && !W.inBounds(nc[0], nc[1]); k++) { const a2 = this.r() * 2 * PI, d2 = Math.sqrt(this.r()) * room; nc = [this.zc[0] + Math.cos(a2) * d2, this.zc[1] + Math.sin(a2) * d2] }
    this.zn = nc
    this.znr = ph.radius
    this.zdps = ph.dps
  }
  zoneNow(): { c: [number, number]; r: number } {
    if (this.t <= this.zs) return { c: this.zc, r: this.zr }
    if (this.t >= this.ze) return { c: this.zn, r: this.znr }
    const f = (this.t - this.zs) / (this.ze - this.zs)
    return { c: [this.zc[0] + (this.zn[0] - this.zc[0]) * f, this.zc[1] + (this.zn[1] - this.zc[1]) * f], r: this.zr + (this.znr - this.zr) * f }
  }

  sc(m: Mech) { return 1 + CFG.cubes.size_per_cube * m.cubes }
  dmgMul(m: Mech) { return 1 + CFG.cubes.damage_per_cube * Math.min(m.cubes, CFG.cubes.stat_cap) }

  canSee(a: Mech, p: V3, h: number): boolean {
    const eye: V3 = [a.pos[0], a.pos[1], a.pos[2] + 8 * this.sc(a)]
    const d = Math.hypot(p[0] - eye[0], p[1] - eye[1])
    const near = CFG.vision.near_range + (a.stats.near_range_bonus ?? 0)
    if (d > near) {
      if (d > CFG.vision.range + (a.stats.vision_bonus ?? 0)) return false
      const yaw = Math.atan2(p[1] - eye[1], p[0] - eye[0])
      if (Math.abs(wrap(yaw - a.aim[0])) > (CFG.vision.fov_deg * PI) / 360) return false
    }
    return W.los(eye, [p[0], p[1], p[2] + h * 0.5], 0.5) || W.los(eye, [p[0], p[1], p[2] + h], 0.5)
  }

  damage(tgt: Mech, amt: number, weapon: string, src: Mech | null, from: V3 | null) {
    if (!tgt.alive) return
    let rear = false
    if (src && from) {
      const yaw = Math.atan2(from[1] - tgt.pos[1], from[0] - tgt.pos[0])
      if (Math.abs(wrap(yaw - tgt.aim[0])) > (CFG.mech.front_arc_deg * PI) / 360) { rear = true; amt *= CFG.mech.rear_mult }
      amt *= 1 - (tgt.stats.armor ?? 0)
    }
    tgt.hp -= amt
    tgt.lastDmgT = this.t
    const bearing = from ? Math.atan2(from[1] - tgt.pos[1], from[0] - tgt.pos[0]) : null
    tgt.events.push({ type: "damaged", amount: +amt.toFixed(1), weapon, bearing, by: src ? src.id : null, ...(rear && { rear: true }) })
    if (src) {
      if (weapon === 'gun') src.hits = (src.hits ?? 0) + 1
      src.dealt = (src.dealt ?? 0) + amt
      src.lastDmgT = this.t
      src.events.push({ type: "hit", target: tgt.id, amount: +amt.toFixed(1), weapon })
      tgt.dmgBy.set(src.id, (tgt.dmgBy.get(src.id) ?? 0) + amt)
    }
    if (tgt.hp <= 0) {
      tgt.alive = false
      tgt.deathT = this.t
      tgt.cause = weapon + (src ? `:${src.id}${src.isBot ? "" : "/t" + src.tier}` : "")
      if (src && src !== tgt) { src.kills++; src.events.push({ type: "kill", target: tgt.id }) }
      for (let i = 0; i < tgt.cubes + CFG.cubes.death_drop_extra; i++) this.cubes.push({ id: this.nextId++, pos: [tgt.pos[0] + this.r() * 4 - 2, tgt.pos[1] + this.r() * 4 - 2, tgt.pos[2]] })
      for (const w of tgt.weapons) if (w && w.kind !== "gun") this.pickups.push({ id: this.nextId++, kind: w.kind, pos: [...tgt.pos] as V3 })
      for (const m of this.mechs) if (m.alive) m.sounds.push({ kind: "death", bearing: Math.atan2(tgt.pos[1] - m.pos[1], tgt.pos[0] - m.pos[0]), dist: "far", age: 0 })
      if (!src?.isBot && src) {} else if (src?.isBot && !tgt.isBot) this.hunters++
    }
  }
  damageNpc(n: Npc, amt: number, src: Mech) {
    if (!n.alive) return
    n.hp -= amt
    n.target = src.id
    src.events.push({ type: "hit", target: n.id, amount: amt, weapon: "x" })
    if (n.hp <= 0) { n.alive = false; for (let i = 0; i < CFG.npc.cubes; i++) this.cubes.push({ id: this.nextId++, pos: [n.pos[0] + i, n.pos[1], n.pos[2]] }) }
  }
  damageCrate(c: { id: number; pos: V3; hp: number }, amt: number) {
    if (c.hp <= 0) return
    c.hp -= amt
    if (c.hp <= 0) {
      this.cubes.push({ id: this.nextId++, pos: [...c.pos] as V3 })
      if (this.r() < CFG.loot.crate_weapon_chance) this.pickups.push({ id: this.nextId++, kind: ["mortar", "laser", "lightning"][Math.floor(this.r() * 3)], pos: [c.pos[0] + 1, c.pos[1], c.pos[2]] })
    }
  }

  emit(src: Mech, kind: string) {
    const range = CFG.sound.range[kind] ?? 100
    for (const m of this.mechs) {
      if (!m.alive || m === src) continue
      const d = Math.hypot(m.pos[0] - src.pos[0], m.pos[1] - src.pos[1])
      if (d > range) continue
      const noise = (this.r() + this.r() + this.r() - 1.5) * ((CFG.sound.bearing_noise_deg * PI) / 180) * 1.4
      m.sounds.push({ kind, bearing: wrap(Math.atan2(src.pos[1] - m.pos[1], src.pos[0] - m.pos[0]) + noise), dist: d < 60 ? "near" : d < 160 ? "mid" : "far", age: 0 })
    }
  }

  // ---------- observation for our bot ----------
  obs(m: Mech): any {
    const vis: any[] = []
    for (const o of this.mechs) {
      if (o === m || !o.alive) continue
      const s = this.canSee(m, o.pos, 9 * this.sc(o))
      if (s) m.seen.set(o.id, this.t)
      if (s || this.t - (m.seen.get(o.id) ?? -99) < CFG.vision.memory_s) {
        vis.push({ id: o.id, kind: "mech", pos: [...o.pos], vel: [...o.vel], aim: [...o.aim], hp: o.hp, max_hp: o.maxHp, cubes: o.cubes, weapons: o.weapons.filter((w) => w).map((w) => w!.kind), charging: o.weapons.some((w) => w?.kind === "laser" && w.charge > 0) })
      }
    }
    for (const n of this.npcs) if (n.alive && this.canSee(m, n.pos, 3.5)) vis.push({ id: n.id, kind: "npc", pos: [...n.pos], vel: [...n.vel], aim: [0, 0], hp: n.hp, max_hp: 350 })
    const items = (arr: any[], h: number) => arr.filter((c) => this.canSee(m, c.pos, h))
    const zn = this.zoneNow()
    const ws = m.weapons.map((w) => w && { kind: w.kind, cooldown: +w.cooldown.toFixed(2), stats: { ...w.stats }, ...(w.kind === "gun" ? { ammo: w.ammo, reload: +w.reload.toFixed(2) } : {}), ...(w.kind === "laser" ? { charge: +w.charge.toFixed(2) } : {}) })
    const o = {
      type: "obs", tick: this.tick, t: +this.t.toFixed(2), alive: this.mechs.filter((x) => x.alive).length,
      self: { id: m.id, pos: [...m.pos], vel: [...m.vel], aim: [...m.aim], hp: m.hp, max_hp: m.maxHp, energy: m.energy, max_energy: m.stats.energy, grounded: m.grounded, cubes: m.cubes, upgrades: [...m.upgrades], weapons: ws, in_zone: Math.hypot(m.pos[0] - zn.c[0], m.pos[1] - zn.c[1]) < zn.r, stats: { ...m.stats, eye_height: 8 * this.sc(m), muzzle_height: 7 * this.sc(m), height: 9 * this.sc(m), radius: 2.5 * this.sc(m) } },
      mechs: vis,
      projectiles: this.projs.filter((p) => p.owner !== m.id && this.canSee(m, p.pos, 0.2)).map((p) => ({ id: p.id, kind: p.kind, pos: [...p.pos], vel: [...p.vel] })),
      crates: items(this.crates.filter((c) => c.hp > 0), 2.4).map((c) => ({ id: c.id, pos: [...c.pos], hp: c.hp })),
      cubes: items(this.cubes, 0.5).map((c) => ({ id: c.id, pos: [...c.pos] })),
      pickups: items(this.pickups, 0.5).map((c) => ({ id: c.id, kind: c.kind, pos: [...c.pos] })),
      sounds: m.sounds, beams: m.beams, events: m.events,
      zone: { center: [...this.zc], radius: this.zr, next_center: [...this.zn], next_radius: this.znr, shrink_start: this.zs, shrink_end: this.ze, dps: this.zdps },
      offer: m.offer, drops: this.drops.filter((d) => !d.taken).map((d) => ({ id: d.id, pos: [...d.pos], radius: CFG.drops.radius, lands_in: +Math.max(0, d.landT - this.t).toFixed(2), capture_s: CFG.drops.capture_s, progress: +d.progress.toFixed(2), holder: d.holder })),
    }
    m.sounds = []; m.beams = []; m.events = []
    return o
  }

  // ---------- house bot AI ----------
  houseAct(m: Mech): any {
    const bot = this.mechs.filter((x) => x.isBot && x.alive)
    const skill = [7, 3.5, 1.8, 0.9][m.tier] * (PI / 180)
    const act: any = {}
    const hunterRank = this.mechs.filter((x) => !x.isBot && x.alive).sort((a, b) => a.tier - b.tier || a.id - b.id).indexOf(m)
    const late = this.t > 300
    const isHunter = hunterRank < this.hunters || late
    // target: our bot if visible to anyone (shared vision) or if hunter
    let tgt: Mech | null = null
    for (const b of bot) {
      const d = Math.hypot(b.pos[0] - m.pos[0], b.pos[1] - m.pos[1])
      const iSee = this.canSee(m, b.pos, 9) && d < 180
      if (iSee || isHunter) if (!tgt || d < Math.hypot(tgt.pos[0] - m.pos[0], tgt.pos[1] - m.pos[1])) tgt = b
      if (!isHunter && !iSee) (m as any).noChase = true; else (m as any).noChase = false
    }
    const zn = this.zoneNow()
    let goal: [number, number] = [this.zn[0], this.zn[1]]
    const st = (m as any).st ?? ((m as any).st = { path: null, pathT: -9, goal: [0, 0], idx: 0, strafe: 1, strafeT: 0 })
    let fightMove: [number, number] | null = null
    if (tgt) {
      const d = Math.hypot(tgt.pos[0] - m.pos[0], tgt.pos[1] - m.pos[1])
      const sees = this.canSee(m, tgt.pos, 9) || (d < 200 && W.los([m.pos[0], m.pos[1], m.pos[2] + 8], [tgt.pos[0], tgt.pos[1], tgt.pos[2] + 4.5]))
      if (sees && d < 230) {
        const muz: V3 = [m.pos[0], m.pos[1], m.pos[2] + 7]
        const tp = tgt.pos, tv = tgt.vel
        let tt = 0, pt: V3 = [tp[0], tp[1], tp[2] + 4.5]
        for (let k = 0; k < 3; k++) { pt = [tp[0] + tv[0] * tt, tp[1] + tv[1] * tt, tp[2] + 4.5 + tv[2] * tt]; tt = Math.hypot(pt[0] - muz[0], pt[1] - muz[1], pt[2] - muz[2]) / CFG.weapons.gun.speed }
        const yaw = Math.atan2(pt[1] - muz[1], pt[0] - muz[0]) + (this.r() - 0.5) * 2 * skill
        const pitch = Math.atan2(pt[2] - muz[2], Math.hypot(pt[0] - muz[0], pt[1] - muz[1])) + (this.r() - 0.5) * skill
        act.aim = [yaw, pitch]
        const err = Math.abs(wrap(m.aim[0] - yaw))
        const fire = [false, false]
        for (let s = 0; s < 2; s++) {
          const w = m.weapons[s]
          if (!w) continue
          if (w.kind === "gun") fire[s] = err < 0.05
          if (w.kind === "laser") fire[s] = w.charge < w.stats.charge ? true : err > 0.02
          if (w.kind === "lightning") fire[s] = d < 44
          if (w.kind === "mortar") fire[s] = false
        }
        act.fire = fire
        if (this.t > st.strafeT) { st.strafe = this.r() < 0.8 ? -st.strafe : st.strafe; st.strafeT = this.t + 0.6 + this.r() * 0.6; st.boost = this.r() < 0.35 }
        const ux = (tp[0] - m.pos[0]) / d, uy = (tp[1] - m.pos[1]) / d
        const want = m.weapons.some((w) => w?.kind === "lightning") ? 30 : 90
        const rad = d > want + 20 ? 1 : d < want - 20 ? -1 : 0
        fightMove = [-uy * st.strafe * 1 + ux * rad, ux * st.strafe * 1 + uy * rad]
      }
      if (!fightMove && !(m as any).noChase) goal = [tgt.pos[0], tgt.pos[1]]
    } else {
      // loot: nearest pickup if slot empty
      if (!m.weapons[1]) {
        let bp: any = null, bd = 150
        for (const p of this.pickups) { const d = Math.hypot(p.pos[0] - m.pos[0], p.pos[1] - m.pos[1]); if (d < bd) { bd = d; bp = p } }
        if (bp) goal = [bp.pos[0], bp.pos[1]]
      } else if (Math.hypot(m.pos[0] - this.zn[0], m.pos[1] - this.zn[1]) < this.znr * 0.6) goal = [m.pos[0], m.pos[1]]
      act.aim = [m.aim[0] + 0.3, 0]
    }
    // keep in zone
    if (Math.hypot(m.pos[0] - zn.c[0], m.pos[1] - zn.c[1]) > zn.r - 10) { goal = [zn.c[0], zn.c[1]]; fightMove = null }
    if (fightMove) { act.move = fightMove; act.boost = !!st.boost && m.energy > 20 }
    else {
      if (!st.path || this.t - st.pathT > 2.5 || Math.hypot(st.goal[0] - goal[0], st.goal[1] - goal[1]) > 15) {
        const s = W.freeNode(m.pos[0], m.pos[1], 10, m.pos[2]), g = W.freeNode(goal[0], goal[1], 14)
        st.path = W.astar(s, g, null, 6000); st.pathT = this.t; st.goal = goal; st.idx = 0
      }
      const p: number[] | null = st.path
      if (p && p.length > 1) {
        let bi = st.idx, bd = Infinity
        for (let i = st.idx; i < Math.min(p.length, st.idx + 10); i++) { const d = Math.hypot(W.nodeX(p[i]) - m.pos[0], W.nodeY(p[i]) - m.pos[1]); if (d < bd) { bd = d; bi = i } }
        st.idx = bi
        const tgtI = Math.min(p.length - 1, bi + 3)
        const dx = W.nodeX(p[tgtI]) - m.pos[0], dy = W.nodeY(p[tgtI]) - m.pos[1], L = Math.hypot(dx, dy) || 1
        act.move = [dx / L, dy / L]
        if (W.gH[p[tgtI]] - m.pos[2] > 1.5) { act.jump = true; act.boost = true }
        if (!act.aim) act.aim = [Math.atan2(dy, dx), 0]
      } else {
        const dx = goal[0] - m.pos[0], dy = goal[1] - m.pos[1], L = Math.hypot(dx, dy) || 1
        act.move = L > 3 ? [dx / L, dy / L] : [0, 0]
      }
    }
    // take weapons
    for (const p of this.pickups) if (Math.hypot(p.pos[0] - m.pos[0], p.pos[1] - m.pos[1]) < 3.8 && !m.weapons[1] && p.kind !== "mortar") act.take = p.id
    if (m.offer) act.pick = 0
    if (process.env.SIM_PEACE) act.fire = [false, false]
    if (m.weapons[0]?.ammo === 0) act.reload = true
    return act
  }

  // ---------- physics ----------
  wallBlocked(x: number, y: number, z: number, r: number, h: number): boolean {
    if (!W.inBounds(x, y)) return true
    const R = Math.ceil(r)
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      if (di * di + dj * dj > r * r) continue
      const k = W.idx(x + di, y + dj)
      if (!W.struct[k]) continue
      const b1 = W.b1[k]
      if (b1 === b1 && W.t1[k] > z + CFG.mech.step_up && b1 < z + h) return true
      const b2 = W.b2[k]
      if (b2 === b2 && W.t2[k] > z + CFG.mech.step_up && b2 < z + h) return true
    }
    return false
  }

  stepMech(m: Mech) {
    const c = m.cmd
    const st = m.stats
    const charging = m.weapons.some((w) => w?.kind === "laser" && w.charge > 0)
    // aim slew
    const dy = wrap(m.cmdAim[0] - m.aim[0])
    const ty = st.turn_rate * DT
    m.aim[0] = wrap(m.aim[0] + Math.max(-ty, Math.min(ty, dy)))
    const dp = m.cmdAim[1] - m.aim[1]
    const tp = st.pitch_rate * DT
    m.aim[1] += Math.max(-tp, Math.min(tp, dp))
    // movement
    let mv = c.move ?? [0, 0]
    const L = Math.hypot(mv[0], mv[1])
    if (L > 1) mv = [mv[0] / L, mv[1] / L]
    let speed = st.walk_speed
    const spend = (e: number) => { m.energy = Math.max(0, m.energy - e); m.spendT = this.t }
    if (c.boost && m.grounded && L > 0.1 && m.energy > 0) { speed = st.boost_speed; spend(st.boost_drain * DT) }
    if (charging) speed *= st.charge_move_mult
    const acc = m.grounded ? st.ground_accel : st.air_accel
    for (let a = 0; a < 2; a++) {
      const want = mv[a] * speed
      const dv = want - m.vel[a]
      const mx = acc * DT
      m.vel[a] += Math.max(-mx, Math.min(mx, dv))
    }
    if (c.jump && m.grounded) { m.vel[2] = st.jump_speed; m.grounded = false; c.jump = false }
    if (!m.grounded) {
      m.vel[2] -= st.gravity * DT
      if (c.boost && m.energy > 0) { m.vel[2] = Math.min(st.max_rise_speed ?? 10, m.vel[2] + st.jet_accel * DT); spend(st.jet_drain * DT) }
    }
    if (this.t - m.spendT > st.energy_regen_delay) m.energy = Math.min(st.energy, m.energy + st.energy_regen * DT)
    const r = 2.5 * this.sc(m), h = 9 * this.sc(m)
    // horizontal with sliding
    const nx = m.pos[0] + m.vel[0] * DT, ny = m.pos[1] + m.vel[1] * DT
    const tryPos = (x: number, y: number) => {
      if (this.wallBlocked(x, y, m.pos[2], r, h)) return false
      const s = W.surfAt(x, y)
      if (m.grounded && s > m.pos[2] + st.step_up) return false
      if (!m.grounded && s > m.pos[2] + 0.1) return false
      // slope
      if (m.grounded && s - m.pos[2] > Math.tan((st.max_slope_deg * PI) / 180) * Math.hypot(x - m.pos[0], y - m.pos[1]) + 0.15 && W.surfAt(x, y) - W.groundAt(x, y) < 0.3 && s - m.pos[2] > 0.3) return false
      m.pos[0] = x; m.pos[1] = y
      return true
    }
    if (!tryPos(nx, ny)) {
      if (!tryPos(nx, m.pos[1])) m.vel[0] = 0
      if (!tryPos(m.pos[0], ny)) m.vel[1] = 0
    }
    // vertical
    const s = W.surfAt(m.pos[0], m.pos[1])
    if (m.grounded) {
      if (s < m.pos[2] - 0.6) { m.grounded = false; m.vel[2] = 0 } else { m.pos[2] = s; m.vel[2] = 0 }
    } else {
      m.pos[2] += m.vel[2] * DT
      if (m.pos[2] <= s) { m.pos[2] = s; m.vel[2] = 0; m.grounded = true }
    }
    // weapons
    const fire = c.fire ?? [false, false]
    for (let i = 0; i < 2; i++) {
      const w = m.weapons[i]
      if (!w) continue
      w.cooldown = Math.max(0, w.cooldown - DT)
      if (w.kind === "gun") {
        if (w.reload > 0) { w.reload -= DT; if (w.reload <= 0) { w.reload = 0; w.ammo = w.stats.mag } }
        if (c.reload && w.reload === 0 && w.ammo < w.stats.mag) { w.reload = w.stats.reload; c.reload = false; this.emit(m, "reload") }
        if (fire[i] && w.cooldown <= 0 && w.reload === 0 && w.ammo > 0) {
          w.ammo--; w.cooldown = w.stats.cooldown
          m.shots = (m.shots ?? 0) + 1
          if (w.ammo === 0) w.reload = w.stats.reload
          const sp = ((w.stats.spread_deg * PI) / 180)
          const g = () => (this.r() + this.r() + this.r() - 1.5) * 1.15
          const yaw = m.aim[0] + g() * sp, pitch = m.aim[1] + g() * sp
          const dir: V3 = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)]
          const o: V3 = [m.pos[0] + dir[0] * 3, m.pos[1] + dir[1] * 3, m.pos[2] + 7 * this.sc(m) + dir[2] * 3]
          this.projs.push({ id: this.nextId++, kind: "gun", pos: o, vel: [dir[0] * w.stats.speed, dir[1] * w.stats.speed, dir[2] * w.stats.speed], owner: m.id, dmg: w.stats.damage * this.dmgMul(m), left: w.stats.range, ttl: 5 })
          this.emit(m, "gun")
        }
      } else if (w.kind === "laser") {
        if (this.t < m.shortUntil) { w.charge = 0; continue }
        if (fire[i] && w.cooldown <= 0) {
          w.charge += DT
          if (w.charge >= w.stats.charge + w.stats.hold_s) this.fireLaser(m, w)
        } else if (w.charge > 0) {
          if (w.charge >= w.stats.min_charge) this.fireLaser(m, w)
          else w.charge += DT
        }
      } else if (w.kind === "lightning") {
        if (fire[i] && w.cooldown <= 0 && m.energy >= w.stats.energy) {
          w.cooldown = w.stats.cooldown; spend(w.stats.energy)
          this.fireLightning(m, w)
          this.emit(m, "lightning")
        }
      } else if (w.kind === "mortar") {
        if (fire[i] && w.cooldown <= 0) {
          w.cooldown = w.stats.cooldown
          const dir: V3 = [Math.cos(m.aim[1]) * Math.cos(m.aim[0]), Math.cos(m.aim[1]) * Math.sin(m.aim[0]), Math.sin(m.aim[1])]
          const o: V3 = [m.pos[0] + dir[0] * 3, m.pos[1] + dir[1] * 3, m.pos[2] + 9.5 * this.sc(m) + dir[2] * 3]
          this.projs.push({ id: this.nextId++, kind: "mortar", pos: o, vel: [dir[0] * w.stats.speed, dir[1] * w.stats.speed, dir[2] * w.stats.speed], owner: m.id, dmg: w.stats.damage * this.dmgMul(m), left: 1e9, ttl: w.stats.ttl })
          this.emit(m, "mortar")
        }
      }
    }
    // pickups: cubes
    for (let k = this.cubes.length - 1; k >= 0; k--) {
      const cb = this.cubes[k]
      if (Math.hypot(cb.pos[0] - m.pos[0], cb.pos[1] - m.pos[1]) < CFG.cubes.pickup_radius && Math.abs(cb.pos[2] - m.pos[2]) < 4) {
        this.cubes.splice(k, 1)
        const before = m.cubes
        m.cubes++
        if (m.cubes <= CFG.cubes.stat_cap) { const add = CFG.mech.hp * CFG.cubes.hp_per_cube; m.maxHp += add; m.hp += add }
        m.events.push({ type: "pickup", cubes: m.cubes })
        if (CFG.cubes.upgrade_thresholds.some((th: number) => th > before && th <= m.cubes)) this.makeOffer(m)
      }
    }
    // take
    if (c.take !== undefined) {
      const p = this.pickups.find((q) => q.id === c.take)
      if (!p) m.events.push({ type: "take_failed", id: c.take, reason: "gone" })
      else if (Math.hypot(p.pos[0] - m.pos[0], p.pos[1] - m.pos[1]) > CFG.loot.pickup_radius || Math.abs(p.pos[2] - m.pos[2]) > 4) m.events.push({ type: "take_failed", id: c.take, reason: "range" })
      else if (m.weapons.some((w) => w?.kind === p.kind)) m.events.push({ type: "take_failed", id: c.take, reason: "have" })
      else {
        let slot = m.weapons[1] ? (m.weapons[0] ? -1 : 0) : 1
        if (slot < 0 && c.drop !== undefined) {
          slot = c.drop
          const old = m.weapons[slot]!
          this.pickups.push({ id: this.nextId++, kind: old.kind, pos: [...m.pos] as V3 })
          m.events.push({ type: "dropped", id: this.nextId - 1, kind: old.kind, slot })
        }
        if (slot < 0) m.events.push({ type: "take_failed", id: c.take, reason: "full" })
        else {
          const w = mkW(p.kind); w.cooldown = Math.max(CFG.loot.equip_s, w.stats.cooldown)
          m.weapons[slot] = w
          this.pickups.splice(this.pickups.indexOf(p), 1)
          m.events.push({ type: "took", id: p.id, kind: p.kind, slot })
        }
      }
      c.take = undefined
    }
    // zone
    const zn = this.zoneNow()
    const out = Math.hypot(m.pos[0] - zn.c[0], m.pos[1] - zn.c[1]) > zn.r
    if (out && this.zdps > 0) this.damage(m, this.zdps * DT, "zone", null, null)
    // regen
    if (!out && this.t - m.lastDmgT > st.regen_delay && m.hp < m.maxHp) m.hp = Math.min(m.maxHp, m.hp + st.regen_per_s * DT)
  }

  makeOffer(m: Mech) {
    const opts = (CFG.upgrades as any[]).filter((u) => (!u.requires || m.weapons.some((w) => w?.kind === u.requires)) && m.upgrades.filter((x) => x === u.id).length < u.max)
    const ch: any[] = []
    while (ch.length < 3 && opts.length) ch.push(opts.splice(Math.floor(this.r() * opts.length), 1)[0])
    m.offer = { id: this.nextId++, expires: this.t + 5, choices: ch.map((u) => ({ id: u.id, name: u.name, desc: u.desc })) }
  }
  applyUpgrade(m: Mech, id: string) {
    const u = (CFG.upgrades as any[]).find((x) => x.id === id)
    if (!u) return
    m.upgrades.push(id)
    for (const e of u.effects) {
      const [a, b, c2] = e.path.split(".")
      const apply = (obj: any, k: string) => { if (e.mul) obj[k] *= e.mul; if (e.add) obj[k] = (obj[k] ?? 0) + e.add }
      if (a === "mech") {
        if (b === "hp") { const old = m.maxHp; m.maxHp *= e.mul ?? 1; m.hp += m.maxHp - old } else apply(m.stats, b)
      } else if (a === "weapons") for (const w of m.weapons) if (w?.kind === b) apply(w.stats, c2)
    }
    m.events.push({ type: "upgrade", id })
  }

  hitMechAlong(o: V3, dir: V3, range: number, skip: number): { m: Mech | null; d: number } {
    const wall = W.hitDist(o, [o[0] + dir[0] * range, o[1] + dir[1] * range, o[2] + dir[2] * range])
    let best: Mech | null = null, bd = Math.min(range, wall)
    for (const t of this.mechs) {
      if (!t.alive || t.id === skip) continue
      const r = 2.5 * this.sc(t), h = 9 * this.sc(t)
      // closest approach in xy
      const px = t.pos[0] - o[0], py = t.pos[1] - o[1]
      const hl = Math.hypot(dir[0], dir[1]) || 1e-9
      const u = (px * dir[0] + py * dir[1]) / (hl * hl)
      if (u < 0 || u > bd) continue
      const qx = o[0] + dir[0] * u - t.pos[0], qy = o[1] + dir[1] * u - t.pos[1]
      if (qx * qx + qy * qy > r * r) continue
      const z = o[2] + dir[2] * u
      if (z < t.pos[2] || z > t.pos[2] + h) continue
      if (u < bd) { bd = u; best = t }
    }
    return { m: best, d: bd }
  }

  fireLaser(m: Mech, w: Wpn) {
    const frac = Math.min(1, w.charge / w.stats.charge)
    const dmg = w.stats.damage * (w.stats.min_frac + (1 - w.stats.min_frac) * frac) * this.dmgMul(m)
    w.charge = 0; w.cooldown = w.stats.cooldown
    const dir: V3 = [Math.cos(m.aim[1]) * Math.cos(m.aim[0]), Math.cos(m.aim[1]) * Math.sin(m.aim[0]), Math.sin(m.aim[1])]
    const o: V3 = [m.pos[0] + dir[0] * 3, m.pos[1] + dir[1] * 3, m.pos[2] + 7 * this.sc(m) + dir[2] * 3]
    const h = this.hitMechAlong(o, dir, w.stats.range, m.id)
    this.emit(m, "laser")
    if (h.m) this.damage(h.m, dmg * (h.m.weapons.some((x) => x?.kind === "mortar") ? 1 + w.stats.cookoff : 1), "laser", m, m.pos)
    else {
      for (const n of this.npcs) if (n.alive && pointSeg(n.pos, o, dir, h.d) < 2) { this.damageNpc(n, dmg, m); break }
      for (const c of this.crates) if (c.hp > 0 && pointSeg(c.pos, o, dir, h.d) < 1.6) { this.damageCrate(c, dmg); break }
    }
  }
  fireLightning(m: Mech, w: Wpn) {
    const eye: V3 = [m.pos[0], m.pos[1], m.pos[2] + 7]
    const cands: { p: V3; hit: (d: number) => void; id: number }[] = []
    for (const t of this.mechs) if (t.alive && t !== m) cands.push({ p: t.pos, id: t.id, hit: (d) => this.damage(t, d, "lightning", m, m.pos) })
    for (const n of this.npcs) if (n.alive) cands.push({ p: n.pos, id: n.id, hit: (d) => this.damageNpc(n, d, m) })
    for (const c of this.crates) if (c.hp > 0) cands.push({ p: c.pos, id: c.id, hit: (d) => this.damageCrate(c, d) })
    let cur: V3 = eye
    let dmg = w.stats.damage * this.dmgMul(m)
    const used = new Set<number>()
    for (let j = 0; j <= w.stats.chain; j++) {
      let best: any = null, bd = Infinity
      for (const c of cands) {
        if (used.has(c.id)) continue
        const d = Math.hypot(c.p[0] - cur[0], c.p[1] - cur[1], c.p[2] + 3 - cur[2])
        const lim = j === 0 ? w.stats.range : w.stats.chain_range
        if (d > lim || d >= bd) continue
        if (j === 0 && Math.abs(wrap(Math.atan2(c.p[1] - cur[1], c.p[0] - cur[0]) - m.aim[0])) > (w.stats.cone_deg * PI) / 360) continue
        if (!W.los(cur, [c.p[0], c.p[1], c.p[2] + 3], 0.5)) continue
        bd = d; best = c
      }
      if (!best) break
      used.add(best.id)
      best.hit(dmg)
      dmg *= w.stats.chain_falloff
      cur = [best.p[0], best.p[1], best.p[2] + 3]
    }
  }

  stepProjs() {
    for (let k = this.projs.length - 1; k >= 0; k--) {
      const p = this.projs[k]
      const owner = this.mechs[p.owner]
      const g = p.kind === "mortar" ? CFG.weapons.mortar.gravity : 0
      const o: V3 = [...p.pos] as V3
      p.vel[2] -= g * DT
      const step: V3 = [p.vel[0] * DT, p.vel[1] * DT, p.vel[2] * DT]
      const len = Math.hypot(...step)
      const dir: V3 = [step[0] / len, step[1] / len, step[2] / len]
      const h = this.hitMechAlong(o, dir, len, p.owner)
      let done = false
      let at: V3 = [o[0] + step[0], o[1] + step[1], o[2] + step[2]]
      if (h.m) { at = [o[0] + dir[0] * h.d, o[1] + dir[1] * h.d, o[2] + dir[2] * h.d]; done = true; if (p.kind === "gun" || p.kind === "npc") { if (p.kind === "npc") this.damage(h.m, p.dmg, "npc", null, o); else this.damage(h.m, p.dmg, "gun", owner, o) } else this.damage(h.m, p.dmg, "mortar", owner, at) }
      else if (h.d < len - 0.01) { at = [o[0] + dir[0] * h.d, o[1] + dir[1] * h.d, o[2] + dir[2] * h.d]; done = true }
      if (!done && p.kind === "gun") {
        for (const n of this.npcs) if (n.alive && pointSeg(n.pos, o, dir, len) < 2) { this.damageNpc(n, p.dmg, owner); done = true; break }
        if (!done) for (const c of this.crates) if (c.hp > 0 && pointSeg(c.pos, o, dir, len) < 1.6) { this.damageCrate(c, p.dmg); done = true; break }
      }
      p.pos = at
      p.left -= len; p.ttl -= DT
      if (p.kind === "mortar" && done) {
        // splash
        const ws = CFG.weapons.mortar
        for (const t of this.mechs) {
          if (!t.alive || t === h.m) continue
          const d = Math.hypot(t.pos[0] - at[0], t.pos[1] - at[1], t.pos[2] + 4.5 - at[2])
          if (d > ws.splash_radius + 2.5) continue
          const f = 1 - (1 - ws.splash_edge) * Math.min(1, Math.max(0, d - 2.5) / ws.splash_radius)
          let dm = ws.splash * f * (owner ? this.dmgMul(owner) : 1)
          if (t === owner) dm *= CFG.mech.self_damage_mult
          this.damage(t, dm, "mortar", owner, at)
          t.vel[0] += ((t.pos[0] - at[0]) / Math.max(1, d)) * ws.knock * f; t.vel[1] += ((t.pos[1] - at[1]) / Math.max(1, d)) * ws.knock * f
          t.vel[2] = ws.knock_up * f; t.grounded = false; t.energy = Math.max(0, t.energy - ws.drain * f)
        }
        this.emit(owner, "explosion")
      }
      if (done || p.left <= 0 || p.ttl <= 0) this.projs.splice(k, 1)
    }
  }

  stepNpcs() {
    for (const n of this.npcs) {
      if (!n.alive) continue
      n.cd -= DT
      let tgt: Mech | null = null
      if (n.target >= 0) { const t = this.mechs[n.target]; if (t.alive && Math.hypot(t.pos[0] - n.pos[0], t.pos[1] - n.pos[1]) < CFG.npc.deaggro_range) tgt = t; else n.target = -1 }
      if (!tgt && Math.hypot(n.pos[0] - n.home[0], n.pos[1] - n.home[1]) < CFG.npc.leash) {
        for (const m of this.mechs) if (m.alive && Math.hypot(m.pos[0] - n.pos[0], m.pos[1] - n.pos[1]) < CFG.npc.aggro_range && W.los([n.pos[0], n.pos[1], n.pos[2] + 2], [m.pos[0], m.pos[1], m.pos[2] + 4.5])) { tgt = m; break }
      }
      if (tgt && n.cd <= 0 && W.los([n.pos[0], n.pos[1], n.pos[2] + 2], [tgt.pos[0], tgt.pos[1], tgt.pos[2] + 4.5])) {
        n.cd = CFG.npc.cooldown
        const o: V3 = [n.pos[0], n.pos[1], n.pos[2] + 2]
        const tp: V3 = [tgt.pos[0], tgt.pos[1], tgt.pos[2] + 4.5]
        const d = Math.hypot(tp[0] - o[0], tp[1] - o[1], tp[2] - o[2])
        const sp = (CFG.npc.spread_deg * PI) / 180
        const yaw = Math.atan2(tp[1] - o[1], tp[0] - o[0]) + (this.r() - 0.5) * 2 * sp, pitch = Math.atan2(tp[2] - o[2], Math.hypot(tp[0] - o[0], tp[1] - o[1])) + (this.r() - 0.5) * sp
        const v = CFG.npc.projectile_speed
        this.projs.push({ id: this.nextId++, kind: "npc", pos: o, vel: [Math.cos(pitch) * Math.cos(yaw) * v, Math.cos(pitch) * Math.sin(yaw) * v, Math.sin(pitch) * v], owner: -1 as any, dmg: CFG.npc.damage, left: d + 40, ttl: 3 })
      }
    }
  }

  run(): Mech[] {
    const maxT = CFG.match.duration_s
    while (this.t < maxT) {
      const alive = this.mechs.filter((m) => m.alive)
      if (alive.length <= 1) break
      // decide
      for (const m of alive) {
        let a: any
        if (m.isBot) {
          const o = this.obs(m)
          const t0 = performance.now()
          try { a = m.ctrl.act(o) } catch (e) { console.error("act error", e); a = {} }
          if (process.env.SIM_PEACE) a.fire = [false, false]
          this.timing.push(performance.now() - t0)
          const lab = (m.ctrl.dbg as string).split(' ')[0]
          this.hist[lab] = (this.hist[lab] ?? 0) + 1
        } else { a = this.houseAct(m); m.events = []; m.sounds = []; m.beams = [] }
        m.cmd = { ...m.cmd, ...a, fire: a.fire ?? [false, false], jump: !!a.jump, take: a.take, drop: a.drop, reload: !!a.reload, boost: !!a.boost, move: a.move ?? [0, 0] }
        if (a.aim) m.cmdAim = [a.aim[0], Math.max(CFG.mech.min_pitch, Math.min(CFG.mech.max_pitch, a.aim[1]))]
        if (m.offer && a.pick !== undefined && m.offer.choices[a.pick]) { this.applyUpgrade(m, m.offer.choices[a.pick].id); m.offer = null }
      }
      for (const m of alive) if (m.offer && this.t > m.offer.expires) { this.applyUpgrade(m, m.offer.choices[0].id); m.offer = null }
      // simulate 2 ticks
      for (let s = 0; s < CFG.match.decide_every; s++) {
        for (const m of this.mechs) if (m.alive) this.stepMech(m)
        this.stepProjs()
        this.stepNpcs()
        this.stepDrops()
        this.t += DT
        this.tick++
        if (this.t >= this.ze && this.phase < CFG.zone.phases.length) this.nextPhase()
        // placements
        const nowAlive = this.mechs.filter((m) => m.alive).length
        for (const m of this.mechs) if (!m.alive && m.place === 0) m.place = nowAlive + this.mechs.filter((x) => !x.alive && x.place === 0).length
        // overlap push (light)
        for (let i = 0; i < 16; i++) {
          const a = this.mechs[i]
          if (!a.alive) continue
          for (let j = i + 1; j < 16; j++) {
            const b = this.mechs[j]
            if (!b.alive) continue
            const dx = b.pos[0] - a.pos[0], dy = b.pos[1] - a.pos[1], d = Math.hypot(dx, dy)
            if (d < 5 && d > 0.01 && Math.abs(a.pos[2] - b.pos[2]) < 9) { const p = (5 - d) / 2; a.pos[0] -= (dx / d) * p; a.pos[1] -= (dy / d) * p; b.pos[0] += (dx / d) * p; b.pos[1] += (dy / d) * p }
          }
        }
      }
      if (this.verbose && this.mechs[0].alive) { const b = this.mechs[0]; const vis = this.mechs.filter((x) => x !== b && x.alive && Math.hypot(x.pos[0]-b.pos[0], x.pos[1]-b.pos[1]) < 200).map((x) => `${x.id}@${Math.hypot(x.pos[0]-b.pos[0], x.pos[1]-b.pos[1]).toFixed(0)}`).join(","); if (this.tick % 10 === 0) console.log(`  ${this.t.toFixed(1)} ${b.ctrl.dbg} path=${b.ctrl.path?.length ?? "-"}${(b.ctrl.path as any)?.partial ? "P" : ""} goal=${b.ctrl.pathGoal ? b.ctrl.pathGoal.x.toFixed(0) + "," + b.ctrl.pathGoal.y.toFixed(0) : "-"} ncl=${(b.ctrl.noClimbUntil > this.t) ? 1 : 0} cw=${(this.t - b.ctrl.climbWaitT < 0.3) ? 1 : 0} pos=${b.pos.map((v) => v.toFixed(0))} aim=${b.aim.map((v) => v.toFixed(2))} cmd=${JSON.stringify(b.cmd.move?.map((v: number) => +v.toFixed(2)))} f=${b.cmd.fire} near=${vis}`) }
      if (this.verbose && this.tick % 100 === 0) {
        const b = this.mechs[0]
        console.log(`t=${this.t.toFixed(0)} alive=${alive.length} bot hp=${b.hp.toFixed(0)} pos=${b.pos.map((v) => v.toFixed(0))} w=${b.weapons.map((w) => w?.kind)} cubes=${b.cubes} zone r=${this.zoneNow().r.toFixed(0)} d=${Math.hypot(b.pos[0] - this.zoneNow().c[0], b.pos[1] - this.zoneNow().c[1]).toFixed(0)} hunters=${this.hunters}`)
      }
    }
    // survivors ranked by HP
    const surv = this.mechs.filter((m) => m.alive).sort((a, b) => b.hp - a.hp)
    surv.forEach((m, i) => (m.place = i + 1))
    return this.mechs
  }
}

function pointSeg(p: V3, o: V3, dir: V3, len: number): number {
  const c: V3 = [p[0], p[1], p[2] + 1.5]
  const v: V3 = [c[0] - o[0], c[1] - o[1], c[2] - o[2]]
  const u = Math.max(0, Math.min(len, v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]))
  return Math.hypot(c[0] - o[0] - dir[0] * u, c[1] - o[1] - dir[1] * u, c[2] - o[2] - dir[2] * u)
}

// ---------- main ----------
const args = process.argv.slice(2)
const N = parseInt(args.find((a) => /^\d+$/.test(a)) ?? "8")
const seed0 = parseInt(args.filter((a) => /^\d+$/.test(a))[1] ?? "1")
const verbose = args.includes("--verbose")
const ffaI = args.indexOf("--ffa")
const nBots = ffaI >= 0 ? parseInt(args[ffaI + 1]) : 1
let tot = 0, all: number[] = []
const times: number[] = []
for (let i = 0; i < N; i++) {
  const m = new Match(seed0 + i, nBots, verbose)
  const res = m.run()
  for (let b = 0; b < nBots; b++) {
    const me = res[b]
    const pts = 16 - me.place
    tot += pts; all.push(pts)
    const hs = res.filter((x) => !x.isBot).reduce((a, x) => a + (x.shots ?? 0), 0), hh = res.filter((x) => !x.isBot).reduce((a, x) => a + (x.hits ?? 0), 0)
    console.log(`match ${seed0 + i} bot${b}: hshots ${hs} hhits ${hh} place ${me.place} pts ${pts} kills ${me.kills} died ${me.alive ? "-" : me.deathT.toFixed(0) + "s by " + me.cause} cubes ${me.cubes} w=${me.weapons.map((w) => w?.kind)} hp=${me.hp.toFixed(0)} shots ${me.shots ?? 0} hits ${me.hits ?? 0} dealt ${(me.dealt ?? 0).toFixed(0)} | killer: ${(() => { const k = res.find((x) => me.cause.includes(':' + x.id + '/')); return k ? `shots ${k.shots} hits ${k.hits} hp ${k.hp.toFixed(0)}` : '' })()}`)
  }
  times.push(...m.timing)
  if (args.includes('--hist')) console.log('   ', Object.entries(m.hist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${(v / 10).toFixed(0)}s`).join(' '))
}
times.sort((a, b) => a - b)
console.log(Object.entries(PROF).map(([k, v]) => `${k}=${(v / times.length).toFixed(2)}`).join(' '))
console.log("max", Object.entries(PROFMAX).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" "))
console.log(`MEAN ${(tot / all.length).toFixed(2)} over ${all.length}  act ms p50 ${times[Math.floor(times.length * 0.5)]?.toFixed(1)} p99 ${times[Math.floor(times.length * 0.99)]?.toFixed(1)} max ${times.at(-1)?.toFixed(1)}`)
