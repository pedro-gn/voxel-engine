# SP3b: structural collapse — research

Date: 2026-10-07. Target: the existing browser engine on Ryzen 5 5600 / RTX 5060.
This investigation preceded implementation. The user subsequently approved the proposed defaults; see the [implementation validation](../reviews/2026-10-07-collapse-validation.md) for the completed runtime and measured performance.

## Recommendation

Use exact, edit-driven connectivity over **opt-in collapsible blocks**, with normal fixed solids as terminal supports. Start with a budgeted typed-array flood search; add an exact region-component index for large, repeatedly edited structures when an engine benchmark justifies its maintenance cost. Keep both behind the same collapse module. Fall in connected fragments, with one motion state per fragment and geometry uploaded once.

This recommendation is an inference from the engine's constraints, the sources below and the local microbenchmark. There is no universally fastest algorithm independent of structure size, edit density, initialization cost and memory. Fragment motion and the support rule were proposed at research time and subsequently approved by the user.

## Primary sources and what they establish

1. [Kronnect: Structural Collapse & Debris](https://kronnect.com/docs/voxel-play-4/structural-collapse/). The product uses connectivity to supports and grouped debris. Anchored materials terminate a flood before it spreads through terrain. Its documented search limit can treat oversized groups as supported: that is a gameplay approximation, not a proof of connectivity. Elovox should resume an unfinished search instead of adopting that shortcut.
2. [NVIDIA Blast introduction](https://github.com/NVIDIAGameWorks/Blast/blob/master/docs/api/introduction.rst) and [Blast SDK](https://nvidia-omniverse.github.io/PhysX/blast/index.html). Blast separates destruction connectivity from physics integration, with support chunks and bonds defining actors. This supports keeping Elovox's connectivity module separate from fragment motion and rendering; installing the native SDK is unnecessary for that architecture.
3. [NVIDIA Blast stress solver](https://nvidia-omniverse.github.io/PhysX/blast/docs/api/extensions/ext_stress.html). Material strength requires force propagation over bonds, masses and iterative convergence. Its computation time depends on the iteration count. Connectivity collapse and stress failure are separate features with different costs; start with connectivity unless weight/strength is explicitly selected.
4. [Epic: Destruction Overview](https://dev.epicgames.com/documentation/unreal-engine/destruction-overview?lang=en-US). Chaos combines connected pieces into clusters and evaluates connection failures. This is evidence for grouped simulation, not evidence that a full rigid-body solver is required for Elovox's first collapse milestone.
5. [Seung Lab: connected-components-3d](https://github.com/seung-lab/connected-components-3d). The maintainers describe six-face 3D labeling using array-based union-find and scanning. That is relevant to rebuilding a bounded region's component labels. It is not, by itself, a dynamic deletion algorithm. No source code from this project is copied into Elovox.
6. [Iyer, Karger, Rahul and Thorup: experimental dynamic connectivity](https://people.csail.mit.edu/rahul/papers/dyncon-jea2001.pdf). Fully dynamic algorithms maintain forests and replacement edges, with practical costs sensitive to the input and implementation. Their theoretical bounds do not establish a win for this TypeScript voxel workload; a voxel-level dynamic-tree implementation needs evidence before adopting its complexity.
7. [Dennis Gustafsson: Teardown multiplayer](https://blog.voxagon.se/2026/03/13/teardown-multiplayer.html). The engine author describes rewriting destruction logic using integer fixed-point arithmetic. This fits Elovox's existing deterministic integer physics, without implying that its whole destruction system can be reproduced by a flood fill.

## Existing integration points

| File | Current behavior | Consequence for 3b |
|---|---|---|
| `packages/engine/src/blocks/registry.ts` | Per-type typed tables; `falls` is opt-in | Add a separate structural flag; preserve existing defaults and IDs |
| `packages/engine/src/sim/simulation.ts` | Single writer; commands, gravity, water, region jobs, rules, light, commit | Queue structural changes in `applySet`; cover generation's bulk paths separately |
| `packages/engine/src/sim/jobs.ts` | Count budget; chunk epochs; after 3 restarts, runs with `Infinity`; `finish()` has no work budget | Reusing it unchanged can cause a large scan or detach spike |
| `packages/engine/src/sim/gravity.ts` | One voxel per body; Q8 height and speed; scans crossed cells | Reuse integer motion rules, not hundreds of thousands of body objects |
| `packages/engine/src/protocol.ts` | All falling voxel objects copied on every tick | Publish fragment membership once and poses separately |
| `packages/engine/src/render/falling.ts` | Instanced cubes, all faces, per-cube light/attribute updates every frame | Large fragments need exposed-face meshes and a transform per fragment |
| `packages/engine/src/render/fallingTrack.ts` | Smoothed simulation clock; waits for a landing chunk mesh/version | Extend the handoff to every chunk touched by a fragment |
| `packages/engine/src/world/layout.ts` | 32³ chunks | Use chunk pages for sparse scratch; benchmark smaller index regions if needed |

The generic voxel epochs also advance on the water mirror's quiet writes. Connectivity needs separate **structural epochs**, advanced only when a voxel's structural classification changes. A water-to-air change or grass-age change must not restart a structural search.

## Local experiment

Run:

```powershell
node packages/engine/bench/collapseConnectivity.node.mjs
```

Recorded data: [JSON](2026-10-07-collapse-connectivity-results.json).

Node v24.5.0, Ryzen 5 5600, synthetic 256 × 128 × 256 dense classification buffer. Each strategy shares the same typed queue and neighbor order. There are 5 warmup searches and 21 recorded searches per case, with rotated execution order. Construction and first-search time are recorded separately. Assertions compare support status, discovered/processed counts and read counts across strategies, including nearby/far supports, diagonal contact and the world floor.

| Disconnected cells | `Set` p50 / p95 | Dense stamps p50 / p95 | Chunk bitsets p50 / p95 |
|---:|---:|---:|---:|
| 1,024 | 0.127 / 0.154 ms | 0.082 / 0.101 ms | 0.098 / 0.119 ms |
| 65,536, thin slab | 7.572 / 8.539 ms | 4.608 / 5.396 ms | 5.726 / 6.114 ms |
| 262,144, dense volume | 35.460 / 43.652 ms | 21.052 / 23.738 ms | 24.551 / 33.334 ms |

For the dense case, stamp storage is **32 MiB** for the entire world; bitset pages plus their generation table use **33 KiB** across eight touched chunks. Both use a **1 MiB** retained typed queue. These numbers exclude the input world, JS object/reference overhead and component-index storage; the script reports Set entry counts instead of pretending to measure Set memory.

The earlier exploratory run showed different tail times; this JSON records the final run after adding explicit floor support. Small sub-microsecond cases are below meaningful timer resolution. There are no confidence intervals or isolated-machine guarantees.

These reads bypass `ChunkStore`, lighting, water displacement, job validation, worker transport, meshing and GPU rendering. The benchmark compares visitation representations, not complete collapse systems. It does not benchmark scanline/SAUF, region graphs, dynamic trees or GPU kernels, so it cannot establish a global optimum. However, even this cheap read path exceeds the existing 10 ms tick target for a large monolithic flood: bounded scheduling is necessary.

## Algorithm tradeoffs

| Strategy | Useful property | Cost / correctness limit | Choice |
|---|---|---|---|
| Whole-world connected-component rebuild | Simple independent oracle | Pays for unrelated terrain after every edit | Small-world tests only |
| Neighbor-seeded typed flood | Very cheap when support is nearby; sparse memory | Worst case visits the whole affected component | First implementation and fallback |
| Exact local components + cross-region graph | Reuses topology across edits; queries smaller graph | Initialization, local relabeling, boundary maintenance, extra memory | Profiled second stage |
| Voxel-level union-find only | Fast incremental joins | Cannot correctly split components after removing supports | Reject as dynamic solver |
| Fully dynamic trees/forests | Strong asymptotic update bounds | Complex data structures and constants; extraction still costs at least output size | Reconsider only with profiling evidence |
| GPU connectivity | Potential large-batch throughput | Authoritative world is in sim worker; transfer/synchronization and deterministic integration remain | No first-stage requirement |
| Force/stress solver | Fails by material load, not just disconnection | Adds masses, bonds, iterations and tuning | Separate milestone unless selected |

### Exact region graph, if benchmarks justify it

Each graph vertex must be a **connected component within a region**, not a region itself: two disconnected beams inside the same chunk are not connected. Relabel only topology-dirty regions. Edges join components across matching face cells; support contacts are counted separately. Changes on a border update the adjacent region's edges/supports too. Untouched labels remain reusable.

Begin comparisons with 8³, 16³ and 32³ regions. Smaller regions reduce relabel cost but increase vertices, portals and bookkeeping. A bounded SAUF/local union-find pass is suitable for relabeling; it does not replace cross-region deletion handling. Graph searches must count edge inspections as work, because a vertex can have many boundary contacts. The index remains exact, with no "one support anywhere makes the entire chunk stable" shortcut.

For a 64³ solid collapsible volume aligned to 32³ regions, a warm index could represent connectivity with eight local-component vertices instead of 262,144 voxel vertices. That is an analytical example, not a measured speedup. Building the index and extracting fallen cells still touch voxel data. Highly fragmented input can erase this advantage.

A lazy index must finish validating every region it uses before concluding that no support exists. Dirty regions never contribute trusted edges. Support-result caches require dependency validation; a stale supported boolean can leave a severed roof floating.

## Implementation direction

The [3b design proposal](../specs/2026-10-07-structural-collapse-design.md) defines compatibility, scheduling, body ownership, collision, rendering, checkpoints and staged delivery. The first acceptance run must compare the complete engine with and without 3b on the same scripted edits, including active water. Only those measurements can select final work caps and justify a region index.
