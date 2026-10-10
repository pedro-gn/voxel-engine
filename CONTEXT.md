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
A normal solid block without individual gravity, or the finite world floor, that can hold a face-connected structural fragment.
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

**Underwater view**:
The screen effect shown while the camera, in either camera mode, is under the voxel water level: short-range fog, a blue-green tint and a slight wobble.
_Avoid_: Underwater fog (scene fog is untouched), water tint (the water material's colour)

**View distance**:
The distance from the camera beyond which the world is not drawn; the fog dissolves its last quarter into the sky. Infinity draws the whole world.
_Avoid_: Render distance, chunk radius, LOD
