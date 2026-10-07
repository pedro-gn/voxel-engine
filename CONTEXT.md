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
