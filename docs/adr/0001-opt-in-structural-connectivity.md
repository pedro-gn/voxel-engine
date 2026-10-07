# Opt-in structural connectivity

SP3b uses face connectivity to fixed normal solids or the world floor, with structural participation disabled by default. This preserves existing terrain and individual sand/gravel gravity, bounds searches at fixed supports, and avoids adding a per-frame material stress solver; a single surviving connection can therefore hold a large structure. Detached cells fall in connected vertical fragments, with bounded search and grid-mutation work; material strength and full rigid-body rotation require a later explicit change of model.
