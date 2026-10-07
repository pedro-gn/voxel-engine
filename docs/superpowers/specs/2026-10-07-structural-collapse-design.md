# Elovox — Sub-project 3b: Structural collapse — design

Date: 2026-10-07.
Status: approved by the user on 2026-10-07; implemented and validated. See the [validation report](../reviews/2026-10-07-collapse-validation.md) for measured limits and final defaults.
Builds on SP3a's gravity/jobs and the completed SP3d water integration.
Evidence and alternatives: [research](../research/2026-10-07-structural-collapse.md).

## 1. Confirmed requirement and proposed defaults

**Confirmed by the user:** block types opt in to structural collapse. Normal block types retain their current behavior; enabling 3b must not make every solid block fall.

**Approved defaults:** six-face connectivity to fixed normal solids or the finite world floor; connected fragments with vertical integer motion, preserving their shape. Weight/strength, rotation, lateral tumbling and impact fracture are separate features.

This connectivity model allows any overhang that still has a face-connected path to support. A single remaining connection can hold a large structure. If that behavior is unwanted, material resistance changes the support model and its performance budget; it is not a cosmetic parameter on this solver.

## 2. Block interface and compatibility

```ts
defineBlock({ name: 'stone', textures: 'stone' }) // current behavior
defineBlock({ name: 'structural_stone', textures: 'stone', collapses: true })
defineBlock({ name: 'sand', textures: 'sand', falls: true }) // current gravity
```

Add `BlockDef.collapses?: boolean`, default `false`, and a `Uint8Array` lookup table in `BlockRegistry`. Derive the internal structural class once per type:

| Type | Structural role |
|---|---|
| Solid, `collapses: true` | Connectivity member; eligible for structural detachment |
| Solid, neither `collapses` nor `falls` | Fixed support; terminal contact, never traversed |
| `falls: true` | Existing individual gravity; not a permanent structural support |
| Air, liquid, spring, non-solid | No structural support |

Reject `collapses` combined with `falls`, `liquid`, `source` or `solid: false` in the first version. This avoids competing ownership by two physics systems. Rendering layer alone does not determine support. A normal solid glass/leaf block is a support under this default, so demo materials should be chosen deliberately.

Append new demo definitions at the end of `BLOCKS`, preserving all existing IDs and terrain hashes. Do not enable collapse retroactively on `stone`, `dirt`, `log`, `planks`, sand or existing trees. A different application can explicitly configure its own collapse-enabled palette.

When no registry type has `collapses: true`, there is no structural scan, no voxel-sized structural allocation and no new recurring publication. A registry-level flag avoids even the collapse notification lookup on ordinary writes.

## 3. Deep module and single writer

`CollapseSystem` owns invalidation, search scratch, component/fragment IDs, scheduling and pending detachments. `Simulation` calls a small internal interface:

- `afterWrite(x, y, z, oldVoxel, newVoxel)` — only structural topology changes queue work.
- `replaceChunk(chunk, voxels, initial)` — bulk generation/regeneration invalidation and direct member seeding.
- `step()` — bounded progress under configured work caps, discovery and admitted fragment motion/transactions.
- `publication(versions)` — membership lifecycle changes plus compact poses and mesh handoff versions.
- `mixState(mix)` — deterministic future-affecting state.

The module receives a world/registry port and writes through simulation hooks. It does not create a new authoritative worker. Connectivity remains in the existing sim worker; mesh workers may prepare fragment geometry from immutable fragment payloads. There is no world-write permission in a render worker.

Retain the original gravity interface for sand/gravel. Share integer integration/collision primitives where that removes duplication, while keeping ownership explicit. A structural fragment is not a list of newly invented sand-like bodies.

## 4. Detection and bounded work

1. Classify the old and new voxel. If structural class is unchanged, no connectivity invalidation is needed; detach payloads read the current voxel ID/state before ownership transfer.
2. Increment a structural epoch for the changed chunk. Queue the edited member and six neighboring member cells, deduplicated in a stable order. Removal of a normal support matters even when it was never traversed.
3. At a fixed phase after ordinary gravity/water and before final light/commit, consume the pending edits. Searches resume between ticks. Subsequent rule writes enter the next search phase.
4. Search only collapsible members. A fixed support or `y === 0` proves support and ends a search. World sides/top and diagonal contacts are not supports.
5. A disconnected component is proven only when its frontier is exhausted against valid structural epochs. An exhausted work budget means **pending**, never supported or unsupported.
6. Reuse a typed position queue and lazy 32³ bitset pages. Recycle scratch under an explicit memory policy. Avoid objects/tuples per visited cell, recursion and `Array.shift()` in hot loops.
7. Deduplicate overlapping seed searches. Reached cells may share a supported result only when they have an actual validated connection to that result; a generic "visited" bit is not a support certificate.

Final defaults: **4,096 visited cells, 128 grid mutations per tick, 128 cells per fragment and at most 64 moving fragments**. The mutation cap counts both detachments and landings. These are deterministic count caps, not elapsed-time limits; the selected desktop passed the measured p95 gate. Payload construction is bounded by fragment size. A cold typed-queue growth still copies its previous allocation, and mesh-version publication depends on the number of bounded fragments; these costs are included in full-tick benchmarks.

The existing `JobRunner` cannot be reused unchanged: after three restarts it ignores its cap, and `finish()` can write an entire region. Add a bounded restart policy for collapse without changing legacy job semantics, or keep a bounded scheduler internal to the collapse module. Search reset, epoch validation and scratch cleanup need cursor-based progress if they are large.

Normal water mirror writes must not invalidate structural work. Actual solid topology edits do. Repeated edits may postpone an affected component while other components progress; there is no unbounded "catch up now" fallback. Once edits stop, the valid search must finish. Fair round-robin work across admitted searches avoids a permanently changing first job blocking unrelated regions.

The exact region index in the research is an optimization stage, not a prerequisite for correct small-scene behavior. Adopt it only after measuring construction, updates, memory and full engine tick latency against the same voxel-search oracle.

## 5. Fragment ownership and transfer

Keep three distinct states: grid-owned voxels, pending proven detachments, and dynamic fragment-owned voxels. Each voxel belongs to exactly one state of ownership; pending voxels are still in the grid. Preserve full voxel IDs and state bits.

For bounded transactions, partition a very large disconnected component into connected fragments, with a final default maximum of **128 cells**. Partial fragments are selected from an available base and cannot rest on pending grid members below them; this avoids a detach/land/recheck loop on thick slabs. When an entire connected remainder fits the allowance, it transfers together. A single large atomic detach would have O(component size) write, lighting and water cost and cannot promise a bounded tick.

Admit a complete fragment only when the mutation budget and dynamic-body capacity permit its detach. Remove its grid cells and create its body in the same simulation phase. Do not remove cells over several ticks while simultaneously drawing the complete fragment. Large structures may therefore begin falling in successive fragments; report that latency honestly.

At capacity, remaining components stay pending in the grid and physics remains busy. Do not delete old bodies or silently mark oversized components supported. Preflight destination slot capacity before removing source voxels. Allocation failures and unexpected ownership-transfer exceptions are fatal: the host stops instead of advancing a partially applied transaction. Expected edit/regeneration overlaps are rejected without writes.

An intervening edit that restores support cancels or rechecks the remaining pending portion. Self-generated detach writes should be coalesced rather than starting duplicate global checks for every cell. They still invalidate any support dependencies they change.

Canonical seed/neighbor/fragment order and monotonically allocated IDs determine results. Hash pending seeds, frontier/progress, fragment payloads, motion, reservations and allocation state whenever they can change future simulation. An independently rebuilt acceleration index may be omitted from the hash only if it provably cannot change observable scheduling or results.

## 6. Motion, contacts and landing

Use the existing Q8 scale, gravity and terminal-speed constants as initial motion rules. A fragment has one vertical position/velocity and immutable local cells; no lateral movement or rotation in this version.

Collision must sweep crossed integer cells, not only inspect the target height. Precompute all downward exposed faces, including the base of **every vertical run**: a single lowest cell per x/z column would miss an obstacle inside an arch or internal cavity. Use a dynamic occupancy index to prevent fragments and ordinary falling bodies passing through or overwriting each other. Resolve equal-time interactions in a canonical order.

Commands/regeneration overlapping a dynamic footprint need a defined reservation rule; the proposed first rule rejects overlapping placement/regeneration and allows source-grid edits outside the moving body. The rejection must be reported through the existing command ack/regeneration error path. Test this explicitly rather than allowing overlap to be discovered during landing.

The fragment stops at its first blocking contact and reinserts its complete shape through ordinary simulation write hooks. Every destination must be available or a permitted flowing liquid; springs are protected like in current gravity. A fragment landing on support is stationary only after the support solver confirms the resulting connectivity. Unsupported residues may fall again; no arbitrary floating freeze.

Normal water displacement is applied on grid reinsertion. While moving, the fragment uses the same water interaction convention as existing falling blocks; buoyancy and continuous submerged-volume displacement are separate work. Exercise sealed cavities and multi-layer water, and verify water accounting rather than assuming a generic falling block test covers fragment landings.

## 7. Publication and rendering

Fragment birth sends packed local coordinates and voxel data once, with a generation/ID. Tick updates send poses in typed arrays; land/cancel events carry lifecycle changes and affected chunk versions. Avoid copying membership and hundreds of thousands of objects at 20 Hz. Transfer ownership of publication buffers carefully; simulation retains its authoritative payload.

Mesh exposed faces once per fragment, reusing the engine's face texture/light/material conventions. Prefer greedy face merging when it measurably helps. Per-frame work updates a fragment transform and bounds, not all its voxel positions. Preserve cutout/translucent materials if those types opt in; the current opaque falling-cube material is insufficient for them. One draw call per fragment is still costly at high counts: measure draw calls and batch compatible small fragments if profiling requires it.

Use the existing simulation clock/interpolation. Source-grid removal and debris appearance need coordinated mesh versions. Landing handoff waits for **all** affected destination chunks, including border-neighbor meshes when applicable. A single chunk's version cannot certify that an entire spanning fragment is visible. Browser checks must catch duplicated old source meshes, disappearing debris, black flashes and a pause/resume jump.

## 8. Generation, editor, idle and stats

Initial generation and `replaceColumns` bypass per-cell edit hooks. Explicitly invalidate/index regenerated areas and neighboring structural contacts. Initial isolated collapse-enabled cells queue checks; current generators contain no such cells and retain current results.

While physics is paused, accumulate/coalesce structural dirtiness but do not detach or advance fragments. Reconcile dirty regions when physics resumes. Regeneration cannot orphan live fragments or their reservations. With empty queues and no moving bodies, collapse work and recurring membership traffic are zero.

Extend `physicsBusy` to include pending structural checks, detachments and moving fragments. Stats should expose visited cells, edge checks if indexed, queued checks, restarts, pending cells/fragments, moving cells/fragments, mutation counts and transport bytes. Keep these counters out of the product flow except the existing debug HUD.

## 9. Delivery slices and acceptance

1. **Compatibility:** registry flag/classification/validation, new appended palette entries, disabled fast path. Existing tests and terrain hashes remain unchanged.
2. **Exact connectivity:** bounded incremental oracle-compatible search; structural epochs; edits, pause/resume and generation. Verify outputs against a simple full rebuild on small random worlds.
3. **Ownership and motion:** bounded fragment transactions, swept contacts, shared falling-body reservations, failure recovery, deterministic replay, complete state hashing.
4. **Visual integration:** packed lifecycle/poses, exposed-face fragment meshes, source/landing handoff, a `?scene=collapse` demonstration and browser checkpoints.
5. **Performance:** profile full engine on near/far supports, slabs, multiple independent supports, fragmented structures, repeated edits and simultaneous water. Compare warm/cold voxel and region-index options, including index sizes 8/16/32 if relevant. Select caps from evidence.

Required scenarios:

- Removing the final support drops only the enabled structure; a normal floating stone remains normal.
- Removing one of two supports leaves the structure in place; removing both makes it fall.
- Diagonal contact gives no support; long cross-chunk paths and an alternate support beyond a local radius remain correct.
- Two disconnected pieces in one chunk are never merged by an index.
- A changing voxel state or water mirror does not starve a check; a real support edit invalidates it.
- Budget exhaustion and body-capacity pressure delay work without losing voxels or permanently declaring stability.
- A new support added before detachment prevents an obsolete collapse.
- A slab, an arch with an internal obstacle, multiple falling fragments and sand meet without tunneling, duplication or overwrite.
- Landing into water preserves the engine's expected accounting; springs and multi-layer roofs remain valid.
- Replaying identical seed/commands/configuration yields identical grid, fragment and pending-work hashes.
- Once everything is supported/landed, physics reaches idle with zero recurring collapse scans.

On the selected desktop, preserve the existing **total tick p95 ≤ 10 ms / FPS p5 ≥ 45** target in controlled 1280 × 720 headed Chrome/WebGPU production runs. Record maximum ticks too, along with detection latency, first-fall latency, final-settlement time, active fragment count, memory and payload bytes. Idle scenes with no opted-in types need no recurring structural cost. See the validation report for measured production peaks, complete Node tick costs, an active-water replay and remaining unmeasured combinations.
