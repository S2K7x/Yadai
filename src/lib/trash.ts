/**
 * The recycle bin: deleting a conversation stops destroying it.
 *
 * The constraint that decides the whole design: `DELETE /api/sessions/{id}`
 * really does drop the rows from Hermes' `state.db` — transcript, tool calls,
 * FTS5 entries, the lot. There is no undo upstream and no soft-delete flag to
 * borrow. So a bin is only honest if the app **never calls that endpoint**
 * until the grace period is up.
 *
 * Hence: "delete" writes a `deleted_at` on our own `session_meta` row and the
 * conversation drops out of every list this app shows. Upstream, nothing
 * happens at all. The real delete is the sweep, thirty days later.
 *
 * Two things were checked in Hermes' sources before promising thirty days,
 * because a promise nobody upstream has agreed to is not a promise
 * (`hermes_state.py`, `hermes_cli/config_defaults.py`, 0.20.0):
 *
 * - `sessions.auto_archive` — `maybe_auto_archive` is documented as the
 *   "non-destructive sibling": it archives, never deletes. Default `false`.
 * - `sessions.auto_prune` — `maybe_auto_prune_and_vacuum` *is* destructive,
 *   but it is `false` by default, needs `retention_days` (90) of inactivity,
 *   and only touches **ended** sessions. This machine has no `sessions:` block
 *   in `~/.hermes/config.yaml`, so both defaults apply and nothing upstream
 *   will collect a conversation out from under the bin.
 *
 * Everything here is pure so the arithmetic can be tested against a fixed
 * clock — same convention as `parseSchedule()` and `groupSessions()`.
 */

/** How long a deleted conversation stays recoverable. */
export const TRASH_DAYS = 30;

const DAY_SECONDS = 86_400;

export interface TrashState {
	/** Whole days left before the sweep may take it. 0 on the last day. */
	daysLeft: number;
	/** The grace period is over: the next sweep is entitled to delete it. */
	expired: boolean;
}

/**
 * How much of the grace period is left.
 *
 * Rounded **down**, deliberately. This number is the app promising how long
 * something can still be recovered, and the safe direction to be wrong in is
 * the pessimistic one: 29.9 days left reads as "29 days left", never as "30".
 */
export function trashState(
	deletedAt: number,
	now: number = Date.now() / 1000,
	days: number = TRASH_DAYS
): TrashState {
	const remaining = deletedAt + days * DAY_SECONDS - now;
	if (!Number.isFinite(remaining) || remaining <= 0) return { daysLeft: 0, expired: true };
	return { daysLeft: Math.floor(remaining / DAY_SECONDS), expired: false };
}

/** What a row in the bin says about its own deadline, in French. */
export function trashLabel(
	deletedAt: number,
	now: number = Date.now() / 1000,
	days: number = TRASH_DAYS
): string {
	const { daysLeft, expired } = trashState(deletedAt, now, days);
	if (expired) return 'deleting soon';
	if (daysLeft === 0) return 'last day';
	return daysLeft === 1 ? '1 day left' : `${daysLeft} days left`;
}

/** A bin row as the server keeps it: an id and when it was thrown away. */
export interface TrashRow {
	session_id: string;
	deleted_at: number;
}

/**
 * The ids the sweep is allowed to delete for real, newest deadline last.
 *
 * Bounded on purpose: this runs off the back of a sidebar refresh, and each id
 * costs one upstream round-trip. Whatever does not fit waits for the next
 * pass — a conversation staying one refresh longer than promised hurts nobody,
 * while a listing that stalls behind fifty deletes hurts every refresh.
 */
export function expiredTrash(
	rows: TrashRow[],
	now: number = Date.now() / 1000,
	limit = 5,
	days: number = TRASH_DAYS
): string[] {
	return rows
		.filter((row) => trashState(row.deleted_at, now, days).expired)
		.sort((a, b) => a.deleted_at - b.deleted_at)
		.slice(0, limit)
		.map((row) => row.session_id);
}
