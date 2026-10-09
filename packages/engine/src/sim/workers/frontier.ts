/** Ticks without progress per point of aging (5 s), and the most an order can gain by waiting. */
export const AGE_TICKS = 100, AGE_CAP = 64

/** An order's priority plus one point per AGE_TICKS since it last progressed, capped at AGE_CAP. */
export const effectivePriority = (priority: number, idleSince: number, now: number): number => priority + Math.min(AGE_CAP, Math.floor((now - idleSince) / AGE_TICKS))
