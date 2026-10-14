# Game logic runs in the sim worker

A game built on Elovox needs logic of its own every tick: needs and jobs that decide where its units go, what they dig and build, and a state of its own that a save must keep. That logic runs inside the simulation worker as game systems, called once per tick right after the worker units step, in the order the game lists them. A system sees this tick's unit results (arrivals, digs, failures, falls, deaths) and what it asks of its units takes effect in the next tick's unit step; it never sees a world half-way through a step.

The units a system drives are controlled units: the engine never assigns them work, they follow one intent at a time (walk to, dig, build) and report what happened. Resources belong to the game: a controlled unit's dig removes the voxel and yields an event, not engine stock or a pile, and its build takes no stock. Uncontrolled units, scenes without systems and worlds without the new options behave as before.

Each system is a save section of its own (`system:<name>`, with the system's own version, JSON state and its random generator), taken in the same tick as the world. The engine never interprets that state, and since the engine opens a save before the game's systems are known, the game checks its sections itself (`checkSystemSections`) and the sim refuses a mismatch at boot.

Rejected: driving the engine from the main thread, which costs a tick of round trip on every decision, takes the game's state and the world's at different moments for a save, and puts game logic on the thread that renders; and a separate game worker, which has the same problems plus the plumbing between two workers.

Consequences: a system's exception in `init`, `restore`, `tick` or `publish` is fatal to the simulation, like any engine bug (a throw in `command` only refuses that command); systems share the sim worker's tick budget; and a game that changes a system's state layout bumps its version and refuses older saves unless it migrates them.
