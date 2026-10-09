# Elovox — Sub-project 4c: AABB collision — Review

Date: 2026-10-08. Branch `feat/collision` (from main 90e5c97). Spec:
`docs/superpowers/specs/2026-10-08-collision-design.md` (approved at 68eff31). Plan:
`docs/superpowers/plans/2026-10-08-collision.md` (approved at 4edc61f).

## Delivered against spec §3

| API | Commit | Status |
|---|---|---|
| `Box`, `bodyBox`, `CollisionWorld`, `CONTACT_EPS`, `GROUND_EPS`, `boxOverlapsSolid` | 2ea0b33 | done |
| `sweepBox` (exact per-axis slab sweep, y then the larger horizontal axis) | ab49194 | done |
| `groundDistance`, `moveBox` (step-up, `grounded`, `ceiling`, `stepped`) | 7356f46 | done |
| `unstick` | f5b921b | done |
| `liquidAt`, `liquidInBox` (voxel water mirror) | 0e7c575 | done |
| `bindCollision`, `engine.collision`, `index.ts` exports | d21ec03 | done |
| Fix: a drop of exactly `maxDown` counts as ground (reported by fpcontrol) | f29ad7c | done |

Shared files: `engine.ts` has an import line, `readonly collision: Collision` on `Engine`, the binding before
`pickable`, and `collision,` after `raycast: rc,`. `index.ts` has one appended export line. Nothing under `sim/` was
touched.

## Verification

Each command's output went to a file, and the results below come from reading those files.

| Command | Result |
|---|---|
| `npx vitest run test/collision.test.ts` (packages/engine) | 45 passed |
| `npx tsc --noEmit -p .` (packages/engine) | exit 0 |
| `npx vitest run` (packages/engine) | 73 files passed; 826 passed, 2 expected fail (the existing `it.fails` in `waterColumns.test.ts`); exit 0 |
| `npm run typecheck` (repo root, all four workspaces) | exit 0 |

The collision tests cover:

- **Sweep:** stops on every face at the plane; no tunnelling up to 10⁴ blocks; chunk borders; world sides, floor and
  top; huge vertical displacements terminate; diagonal sliding; axis order; corridors; float residue.
- **Creep:** 1000 steps of 1e-8 against a wall do not enter it.
- **Escape:** a box can move out of a block edited into it but not into new solid.
- **Degenerate and non-finite input:** handled without hanging or moving.
- **Step-up:** 1-block ledges with stepHeight 1 and 1.25; refused with 0.6, for 2 blocks, and under ceilings; not
  taken in the air; taken after landing in the same move; no bobbing against a tall wall; stays 0 over a ledge
  followed by a hole.
- **Ground:** the boundary at exactly `maxDown`, within residue, and 1e-6 beyond it; agrees with `moveBox.grounded`.
- **Unstick:** feet block, head block, under a ceiling, and bad input.
- **Liquid:** full and partial cells, springs, shore straddling, a bridge with water under and over it, dry cases.
- **Binding:** ghost edits collide before their ack, and a ghost removal lets the box through.

## Limitations (spec §8)

- The main thread reads air for a chunk whose memory page has not arrived yet. The escape rule and `unstick` are the
  recovery.
- A box that starts outside the world's x/z bounds is stuck.
- Falling blocks, fragments and units are off the grid and do not collide.

## Open items

- None in 4c. Ground snap when walking down stairs, gravity, jumping and swimming belong to the 4d controller.
