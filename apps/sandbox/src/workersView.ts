import { AnimationMixer, BoxGeometry, Color, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Object3D, Quaternion, Raycaster, Vector2, Vector3 } from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone } from 'three/addons/utils/SkeletonUtils.js'
import { WORKER_STATES, type Engine, type Vec3, type WorkerView } from '@elovox/engine'

const STATES: Record<string, string> = { idle: 'Livre', planning: 'Buscando rota', walking: 'Em movimento', working: 'Trabalhando', blocked: 'Aguardando', falling: 'Caindo', incapacitated: 'Incapacitada' }
/** A barrier whose mesh never arrives (e.g. a chunk that failed to mesh) stops holding units after this long. */
const BARRIER_TIMEOUT_MS = 1000
const REASONS: Record<string, string> = { 'no-access': 'Sem acesso', 'missing-material': 'Falta material', 'missing-tool': 'Falta ferramenta', unsafe: 'Passagem perigosa', traffic: 'Passagem ocupada', 'search-limited': 'Limite da busca', 'target-changed': 'Alvo alterado' }

export async function createWorkersView(engine: Engine, canvas: HTMLCanvasElement, { demo = true }: { demo?: boolean } = {}) {
  const scene = new Group(); engine.scene.add(scene)
  const selected = new Set<number>(), views = new Map<number, WorkerView>(), previous = new Map<number, Vector3>()
  const skins = new Map<number, { root: Object3D; mixer: AnimationMixer; clip: string; heading: number }>()
  const barriers = new Map<number, { version: number; since: number }>(), shown = new Map<number, Vector3>()
  const currentPosition = new Vector3(), drawnPosition = new Vector3()
  const gltf = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/bean.glb`)
  const proxyGeo = new BoxGeometry(.65, 1.65, .65), proxyMat = new MeshStandardMaterial({ color: '#dbbb58', roughness: .9 })
  const proxies = new InstancedMesh(proxyGeo, proxyMat, 1000); proxies.castShadow = true; proxies.count = 0; proxies.frustumCulled = false; scene.add(proxies)
  const proxyIds: number[] = [], matrix = new Matrix4(), quat = new Quaternion(), scale = new Vector3(1, 1, 1), color = new Color()
  const outlineGeo = new BoxGeometry(.96, .035, .96), outlineMat = new MeshStandardMaterial({ color: '#edc65c', emissive: '#463a13' })
  const rings = new InstancedMesh(outlineGeo, outlineMat, 1000); rings.count = 0; rings.frustumCulled = false; scene.add(rings)
  const preview = new Mesh(new BoxGeometry(1.02, 1.02, 1.02), new MeshStandardMaterial({ color: '#e5ad48', transparent: true, opacity: .35, depthWrite: false })); preview.visible = false; scene.add(preview)
  let at = performance.now(), mode: 'select' | 'dig' | 'build' = 'select', anchor: Vec3 | null = null
  const callbacks: (() => void)[] = []
  const style = document.createElement('style')
  style.textContent = `
    .workers-panel{position:fixed;right:18px;top:18px;width:280px;max-height:calc(100vh - 36px);overflow:auto;padding:20px;box-sizing:border-box;background:#f6f3e9ed;color:#25382d;border:1px solid #b4bbaa;border-radius:10px;font:13px/1.5 Georgia,serif;z-index:12;box-shadow:0 5px 24px #172b2220}
    .workers-panel h1{font-size:25px;font-weight:normal;margin:0 0 4px}.workers-panel small{display:block;letter-spacing:.12em;font:10px/1.5 Consolas,monospace;text-transform:uppercase;color:#6c7766}
    .workers-panel p{margin:12px 0}.workers-panel button,.workers-panel select{font:12px/1.4 Consolas,monospace;color:inherit;padding:8px 9px;background:#fffdf5;border:1px solid #b4bbaa;border-radius:4px;cursor:pointer}
    .workers-panel button:hover{background:#e8eadb}.workers-panel button:focus-visible,.workers-panel select:focus-visible{outline:2px solid #436947;outline-offset:2px}.workers-panel button[aria-pressed=true]{background:#294f38;color:#fffdf2;border-color:#294f38}
    .workers-tools{display:flex;gap:5px;margin:14px 0 10px}.workers-panel label{display:flex;align-items:center;justify-content:space-between;gap:8px}.workers-panel hr{border:0;border-top:1px solid #c8cbbb;margin:16px 0}.workers-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}.workers-status{font:11px/1.6 Consolas,monospace;white-space:pre-line;max-height:220px;overflow:auto}.workers-help{font-size:12px;color:#697465}.workers-panel [role=status]{min-height:34px;font:11px/1.5 Consolas,monospace;color:#7c5831}
    @media(max-width:700px){.workers-panel{width:245px;right:8px;top:8px;padding:12px}.workers-status{max-height:100px}#hud{display:none}}
  `
  document.head.append(style)
  const panel = document.createElement('aside'); panel.className = 'workers-panel'; panel.setAttribute('aria-label', 'Unidades e obras')
  panel.innerHTML = `<small>Elovox · Campo de trabalho</small><h1>Unidades & obras</h1><div class="workers-tools" role="group" aria-label="Ferramenta"></div><label>Material <select aria-label="Material de construção"><option value="planks">Tábuas</option><option value="stone">Pedra</option><option value="glass">Vidro</option><option value="structural_planks">Tábuas estruturais</option></select></label><p class="workers-help">Clique numa unidade para selecionar. Shift adiciona à seleção. Clique direito envia ao chão. Em obras, Shift + segundo clique define uma área.</p><div class="workers-status"></div><hr><small>Demonstrações</small><div class="workers-actions"></div><hr><div role="status" aria-live="polite"></div>`
  document.body.append(panel)
  const autoLabel = document.createElement('label'), auto = document.createElement('input'); auto.type = 'checkbox'; autoLabel.textContent = 'Abrir passagem ao mover'; autoLabel.append(auto); panel.insertBefore(autoLabel, panel.querySelector('.workers-help'))
  const status = panel.querySelector<HTMLElement>('[role=status]')!, summary = panel.querySelector<HTMLElement>('.workers-status')!, material = panel.querySelector<HTMLSelectElement>('select')!
  const priorityLabel = document.createElement('label'), priority = document.createElement('select'); priorityLabel.textContent = 'Prioridade'; priority.setAttribute('aria-label', 'Prioridade das obras')
  for (const [name, value] of [['Normal', 128], ['Alta', 192], ['Baixa', 64]] as const) { const option = document.createElement('option'); option.textContent = name; option.value = String(value); priority.append(option) }
  priorityLabel.append(priority); panel.insertBefore(priorityLabel, panel.querySelector('.workers-help'))
  const button = (label: string, action: () => void, target = panel.querySelector('.workers-actions')!) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', action); target.append(b); return b
  }
  const tools = new Map<string, HTMLButtonElement>()
  for (const [kind, label] of [['select', 'Selecionar'], ['dig', 'Escavar'], ['build', 'Construir']] as const) {
    const b = button(label, () => { mode = kind; anchor = null; for (const [k, t] of tools) t.setAttribute('aria-pressed', String(k === kind)); status.textContent = kind === 'select' ? 'Selecione e envie as unidades ao destino.' : 'Marque os blocos da obra; as unidades vão até eles.' }, panel.querySelector('.workers-tools')!); tools.set(kind, b); b.setAttribute('aria-pressed', String(kind === mode))
  }
  const ids = () => [...selected].filter(id => views.get(id)?.state !== 'incapacitated')
  const jobIds = () => ({ priority: Number(priority.value), ...(ids().length ? { ids: ids() } : {}) })
  const tunnel = () => engine.submit({ type: 'workDig', min: [22, 5, 29], max: [26, 6, 29], ...jobIds() })
  const bridge = () => engine.submit({ type: 'workBuild', min: [42, 4, 30], max: [46, 4, 30], voxel: engine.blocks.id('planks'), ...jobIds() })
  const wall = () => engine.submit({ type: 'workBuild', min: [32, 5, 28], max: [36, 6, 28], voxel: engine.blocks.id(material.value), ...jobIds() })
  if (demo) { button('Abrir túnel', tunnel); button('Montar ponte', bridge); button('Erguer parede', wall) }
  button('Reabastecer', () => { if (ids().length) engine.submit({ type: 'unitStock', ids: ids(), block: engine.blocks.id(material.value), count: 32 }); else status.textContent = 'Selecione uma unidade para reabastecer.' })
  button('Selecionar todas', () => { selected.clear(); for (const u of views.values()) if (u.state !== 'incapacitated') selected.add(u.id) })
  button('Parar unidades', () => { if (ids().length) engine.submit({ type: 'unitCancel', ids: ids() }) })
  button('Recolher sobra', () => { if (ids().length) engine.submit({ type: 'unitCollect', ids: ids() }) })
  const pause = button('Pausar', () => { engine.physics.setPaused(!engine.physics.paused); pause.textContent = engine.physics.paused ? 'Retomar' : 'Pausar' })
  button('Cancelar obras', () => { for (const o of engine.workers?.orders ?? []) if (!o.cancelled && o.done < o.total) engine.submit({ type: 'workCancel', order: o.id }) })
  callbacks.push(engine.on('ack', ack => { if (!ack.ok) status.textContent = ack.error ?? 'Ordem recusada.' }))
  callbacks.push(engine.on('workers', tick => {
    at = performance.now()
    for (const b of tick.barriers.flatMap(e => e.chunks)) { const old = barriers.get(b.chunk); barriers.set(b.chunk, { version: Math.max(old?.version ?? 0, b.version), since: old?.since ?? at }) }
    for (const u of views.values()) { let p = previous.get(u.id); if (!p) { p = new Vector3(); previous.set(u.id, p) }; p.set(u.x256 / 256, u.y256 / 256, u.z256 / 256) }
    for (const u of tick.details) views.set(u.id, u)
    const alive = new Set<number>()
    for (let i = 0; i < tick.poses.length; i += 9) {
      const p = tick.poses, id = p[i]!, old = views.get(id)
      alive.add(id); views.set(id, { ...old, id, available: old?.available ?? true, x256: p[i + 1]!, y256: p[i + 2]!, z256: p[i + 3]!, facing: p[i + 4]!, state: WORKER_STATES[p[i + 5]!]!, order: p[i + 6]!, progress: p[i + 7]!, duration: p[i + 8]!, stock: old?.stock ?? [] })
      if (!skins.has(id) && skins.size < 24) {
        const root = clone(gltf.scene), mixer = new AnimationMixer(root)
        root.traverse(o => { o.userData.unit = id; if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true } })
        root.rotation.y = p[i + 4]! * Math.PI / 2
        scene.add(root); skins.set(id, { root, mixer, clip: '', heading: root.rotation.y })
      }
    }
    for (const id of views.keys()) if (!alive.has(id)) { views.delete(id); selected.delete(id); previous.delete(id); shown.delete(id); const s = skins.get(id); if (s) { s.mixer.stopAllAction(); scene.remove(s.root); skins.delete(id) } }
  }))
  callbacks.push(engine.on('frame', ({ dt, now }) => {
    for (const [ci, b] of barriers) if (engine.meshVersion(ci) >= b.version || now - b.since > BARRIER_TIMEOUT_MS) barriers.delete(ci)
    // Only units next to an edited chunk wait for its mesh; the rest keep moving.
    const held = (p: Vector3) => {
      for (const ci of barriers.keys()) {
        const [cx, cy, cz] = engine.layout.chunkCoords(ci)
        if (p.x >= cx * 32 - 2 && p.x < cx * 32 + 34 && p.y >= cy * 32 - 2 && p.y < cy * 32 + 34 && p.z >= cz * 32 - 2 && p.z < cz * 32 + 34) return true
      }
      return false
    }
    const alpha = Math.min(1, (now - at) / (1000 / 20)); let pi = 0, ri = 0
    for (const u of views.values()) {
      const current = currentPosition.set(u.x256 / 256, u.y256 / 256, u.z256 / 256), position = barriers.size && shown.has(u.id) && held(shown.get(u.id)!) ? drawnPosition.copy(shown.get(u.id)!) : drawnPosition.copy(previous.get(u.id) ?? current).lerp(current, alpha)
      let displayed = shown.get(u.id)
      const dx = displayed ? position.x - displayed.x : 0, dz = displayed ? position.z - displayed.z : 0
      const moving = dx * dx + dz * dz > 1e-10
      if (!displayed) { displayed = new Vector3(); shown.set(u.id, displayed) }; displayed.copy(position)
      const skin = skins.get(u.id)
      if (skin) {
        skin.root.position.copy(position)
        if (moving) skin.heading = Math.atan2(dx, dz)
        const turn = Math.atan2(Math.sin(skin.heading - skin.root.rotation.y), Math.cos(skin.heading - skin.root.rotation.y))
        if (!engine.physics.paused) skin.root.rotation.y += turn * (1 - Math.exp(-14 * dt))
        skin.root.visible = u.state !== 'incapacitated'
        const name = moving || u.state === 'walking' ? 'walk' : 'idle'
        if (skin.clip !== name) {
          const old = gltf.animations.find(c => c.name === skin.clip), clip = gltf.animations.find(c => c.name === name)
          if (old) skin.mixer.clipAction(old).fadeOut(.12)
          if (clip) skin.mixer.clipAction(clip).reset().fadeIn(.12).play()
          skin.clip = name
        }
        skin.mixer.update(engine.physics.paused ? 0 : dt)
      } else if (u.state !== 'incapacitated') {
        position.y += .825; matrix.compose(position, quat, scale); proxies.setMatrixAt(pi, matrix); proxies.setColorAt(pi, color.set(selected.has(u.id) ? '#fff091' : '#d9b455')); proxyIds[pi++] = u.id; position.y -= .825
      }
      if (selected.has(u.id)) { position.y += .025; matrix.compose(position, quat, scale); rings.setMatrixAt(ri++, matrix) }
    }
    proxies.count = pi; proxies.boundingSphere = null; rings.count = ri; proxies.instanceMatrix.needsUpdate = true; if (proxies.instanceColor) proxies.instanceColor.needsUpdate = true; rings.instanceMatrix.needsUpdate = true
  }))
  const renderSummary = () => {
    const chosen = [...selected].map(id => views.get(id)).filter((u): u is WorkerView => !!u), s = engine.workers?.stats
    const lines = [`${views.size} unidades · ${chosen.length} selecionadas`, `${s?.orders ?? 0} obras · ${s?.tasks ?? 0} tarefas`]
    for (const u of chosen.slice(0, 4)) lines.push(`#${u.id} ${u.reason ? REASONS[u.reason] : u.state === 'idle' && !u.available ? 'Parada' : STATES[u.state]}${u.state === 'working' ? ` ${Math.floor(u.progress * 100 / Math.max(1, u.duration))}%` : ''}`, `  ${u.stock.filter(q => q.count).map(q => `${engine.blocks.name(q.block)} ${q.count}`).join(' · ') || 'Estoque vazio'}`)
    for (const o of engine.workers?.orders ?? []) if (!o.cancelled) lines.push(`${o.kind === 'dig' ? 'Escavação' : 'Construção'} #${o.id} · ${o.done}/${o.total}${o.reason ? ` · ${REASONS[o.reason]}` : ''}`)
    summary.textContent = lines.join('\n')
  }
  const timer = setInterval(renderSummary, 200)
  const caster = new Raycaster(), ndc = new Vector2()
  const pickUnit = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect(); ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); caster.setFromCamera(ndc, engine.camera)
    // Raycaster ignores visibility, so hidden (incapacitated) bodies must be left out explicitly.
    const objects: Object3D[] = [...skins.values()].filter(s => s.root.visible).map(s => s.root)
    if (proxies.count) objects.push(proxies)
    const hits = caster.intersectObjects(objects, true), ground = engine.pickScreen(e.clientX, e.clientY)
    const hit = hits.find(h => h.distance <= (ground?.distance ?? Infinity) && (h.object.userData.unit !== undefined || h.instanceId !== undefined))
    return hit ? hit.instanceId !== undefined ? proxyIds[hit.instanceId] : hit.object.userData.unit as number : undefined
  }
  const target = (e: PointerEvent): Vec3 | null => {
    const hit = engine.pickScreen(e.clientX, e.clientY); if (!hit) return null
    return mode === 'dig' ? hit.pos : [hit.pos[0] + hit.normal[0], hit.pos[1] + hit.normal[1], hit.pos[2] + hit.normal[2]]
  }
  const gestures = new Map<number, { button: number; x: number; y: number; distance: number }>()
  const pointerDown = (e: PointerEvent) => { gestures.set(e.pointerId, { button: e.button, x: e.clientX, y: e.clientY, distance: 0 }) }
  const trackGesture = (e: PointerEvent) => {
    const gesture = gestures.get(e.pointerId)
    if (gesture) { gesture.distance += Math.abs(e.clientX - gesture.x) + Math.abs(e.clientY - gesture.y); gesture.x = e.clientX; gesture.y = e.clientY }
    return gesture
  }
  const pointerCancel = (e: PointerEvent) => { gestures.delete(e.pointerId) }
  const pointerMove = (e: PointerEvent) => {
    trackGesture(e)
    const pos = mode === 'select' ? null : target(e); preview.visible = pos !== null; if (pos) preview.position.set(pos[0] + .5, pos[1] + .5, pos[2] + .5)
  }
  const pointerUp = (e: PointerEvent) => {
    const gesture = trackGesture(e); gestures.delete(e.pointerId)
    if (!gesture || gesture.button !== e.button || gesture.distance >= 6) return
    if (e.button === 2) {
      const hit = engine.pickScreen(e.clientX, e.clientY); if (!hit || !ids().length) return
      engine.submit({ type: 'unitMove', ids: ids(), pos: [hit.pos[0], hit.pos[1] + 1, hit.pos[2]], ...(auto.checked && { allowDig: true, buildBlock: engine.blocks.id(material.value) }) }); return
    }
    if (e.button !== 0) return
    if (mode === 'select') {
      const id = pickUnit(e); if (!e.shiftKey) selected.clear()
      if (id !== undefined) { if (selected.has(id)) selected.delete(id); else selected.add(id) }
    } else {
      const pos = target(e); if (!pos) return
      const from = e.shiftKey && anchor ? anchor : pos
      const min = from.map((v, i) => Math.min(v, pos[i]!)) as unknown as Vec3, max = from.map((v, i) => Math.max(v, pos[i]!)) as unknown as Vec3
      engine.submit(mode === 'dig' ? { type: 'workDig', min, max, ...jobIds() } : { type: 'workBuild', min, max, voxel: engine.blocks.id(material.value), ...jobIds() }); anchor = pos
    }
    renderSummary()
  }
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { selected.clear(); anchor = null; preview.visible = false } }
  canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove); canvas.addEventListener('pointerup', pointerUp); canvas.addEventListener('pointercancel', pointerCancel); window.addEventListener('keydown', key)
  if (demo) for (let i = 0; i < 8; i++) engine.submit({ type: 'unitSpawn', pos: [12 + (i % 4) * 2, 5, 27 + Math.floor(i / 4) * 3], tools: ['pick'], stock: [{ block: engine.blocks.id('planks'), count: 32 }, { block: engine.blocks.id('stone'), count: 16 }, { block: engine.blocks.id('glass'), count: 16 }, { block: engine.blocks.id('structural_planks'), count: 16 }] })
  return {
    tunnel, bridge, wall, selectAll() { for (const u of views.values()) selected.add(u.id) },
    dispose() { clearInterval(timer); for (const off of callbacks) off(); canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointermove', pointerMove); canvas.removeEventListener('pointerup', pointerUp); canvas.removeEventListener('pointercancel', pointerCancel); window.removeEventListener('keydown', key); panel.remove(); style.remove(); engine.scene.remove(scene); proxyGeo.dispose(); proxyMat.dispose(); outlineGeo.dispose(); outlineMat.dispose(); preview.geometry.dispose(); (preview.material as MeshStandardMaterial).dispose(); for (const s of skins.values()) s.mixer.stopAllAction() },
  }
}
