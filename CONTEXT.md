# Elovox

Voxel worlds with editable terrain and deterministic simulation.

## Language

**Collapsible block**:
A block type explicitly enabled for structural collapse. Its participation is independent of the block's visual appearance.
_Avoid_: All solid blocks, destructible block

**Normal block**:
A block type that does not participate in structural collapse. It keeps its existing behavior, including individual gravity when configured for that behavior.
_Avoid_: Indestructible block, immovable block

**Fixed support**:
A normal solid block without individual gravity, or the finite world floor (not in a void world), that can hold a face-connected structural fragment.
_Avoid_: Any solid block, anchored terrain only

**Structural fragment**:
A connected group of collapsible blocks that leaves the grid and falls together while preserving its shape.
_Avoid_: Individual falling block, debris particle

**Worker unit**:
A terrestrial entity controlled by the simulation, with a body, inventory, tools and orders. Rendering follows its published pose.
_Avoid_: Visual character, autonomous terrain editor

**Work order**:
A dig or build designation expanded into bounded tasks, each executed through a conditional world edit.
_Avoid_: Path request, immediate fill

**Work pose**:
A supported position from which a unit can reach and see a task's target without occupying it.
_Avoid_: Target block, nearest empty voxel

**Route action**:
A walk, dig or placement step with explicit prerequisites. Local engineering plans simulate edits without writing the world; execution validates them again.
_Avoid_: Unconditional waypoint, teleport

**Portal**:
A run of crossings from one 16³ navigation region into a neighbouring one, stood for by its middle crossing; one-way when it drops.
_Avoid_: Door, waypoint

**Reservation window**:
The 32 ticks of (cell, tick) pairs a walking unit reserves ahead of itself; a unit standing still holds its cells with no end.
_Avoid_: Lock, path claim

**Wade**:
To walk with the feet in water: a unit enters water only with its head cell dry (up to one block deep), and once in it carries on through water up to 1.5 blocks. A step in water is planned as about three steps but walked at the same speed.
_Avoid_: Swim (units never swim), ford

**Sleeping unit**:
A unit waiting in a queue behind another unit on its way: it skips its decisions until that unit's cells change, its tile changes, a command arrives or 16 ticks pass, but still runs its safety checks.
_Avoid_: Idle unit (no order), blocked unit (a plan failed)

**Decision budget**:
How many units that are not moving, working or idle may take a decision in one tick; the rest wait their turn, longest-waiting first. Units walking on along their path and units waiting for a search or a retry take no slot.
_Avoid_: Tick budget, search budget (operations for searches)

**Underwater view**:
The screen effect shown while the camera, in either camera mode, is under the voxel water level: short-range fog, a blue-green tint and a slight wobble.
_Avoid_: Underwater fog (scene fog is untouched), water tint (the water material's colour)

**View distance**:
The distance from the camera beyond which the world is not drawn; the fog dissolves its last quarter into the sky. Infinity draws the whole world.
_Avoid_: Render distance, chunk radius, LOD

**Game system**:
A game's own simulation code, run by the engine once per tick after the worker units step, with its own commands (`name:`), save section (`system:name`) and per-tick publication.
_Avoid_: Plugin, mod, script

**Controlled unit**:
A worker unit owned by a game system: never given work by the engine, driven by one intent at a time (walk, dig or build), reporting what happened to it. Its digs keep nothing.
_Avoid_: Player unit, NPC

**Void world**:
A world whose bottom is open: water, falling blocks, fragments and units that reach it leave the world.
_Avoid_: Sky world, no-floor mode

**Layer cut**:
The highest visible layer: everything above it is hidden and the cut layer's tops are drawn as solid, darker faces; the simulation is untouched.
_Avoid_: Slice, clipping, x-ray

**Save**:
A package that lets a world continue where it stopped: a manifest plus content-addressed blobs (save regions and system sections). Faithful, not bit-identical: navigation and in-flight searches are rebuilt on load.
_Avoid_: Snapshot (the sim's in-memory capture), replay

**Save slot**:
A name under which the store keeps the newest save, and the one before it so that a write is atomic.
_Avoid_: File, save file

**Save region**:
256 × 256 blocks of the world, full height (8 × 8 chunk columns): the unit a save copies and stores. A save copies only regions written since the slot's last save in the same engine session.
_Avoid_: Region (navigation regions are 16³ tiles; render batch regions are 8 × 8 chunks of meshes)
