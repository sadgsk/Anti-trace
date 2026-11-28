import type { ToolFileAccess } from "../types.ts";

/** Paths are canonical keys supplied by the tool. An empty list has no file conflicts. */
export type ToolAccess = "exclusive" | readonly ToolFileAccess[];

const MAX_CONCURRENT_EXECUTIONS = 4;

interface Slot {
	access?: ToolAccess;
	admit?: () => void;
}

/** One assistant response. Register calls in model order; finish returns results in that same order. */
export class ToolCallScheduler<T> {
	private readonly unfinished = new Set<Slot>();
	private readonly outcomes: Promise<PromiseSettledResult<T>>[] = [];
	private activeExecutions = 0;
	private readonly executionWaiters: Array<{ enter: () => void; abort: (reason: unknown) => void }> = [];
	private closed = false;

	constructor(private readonly signal?: AbortSignal) {
		signal?.addEventListener("abort", this.dispatch, { once: true });
	}

	add(access: ToolAccess | PromiseLike<ToolAccess>, run: () => Promise<T>, skip: () => Promise<T>): void {
		if (this.closed) throw new Error("Tool batch already closed");

		const slot: Slot = {};
		const admitted = new Promise<void>(resolve => {
			slot.admit = () => {
				slot.admit = undefined;
				resolve();
			};
		});
		this.unfinished.add(slot);

		const execution = admitted.then(() => this.signal?.aborted ? skip() : run());
		// A callback can reject while the model is still streaming, before finish() is called.
		this.outcomes.push(execution.then(
			value => ({ status: "fulfilled" as const, value }),
			reason => ({ status: "rejected" as const, reason }),
		).finally(() => {
			this.unfinished.delete(slot);
			this.dispatch();
		}));

		void Promise.resolve(access).catch(() => "exclusive" as const).then(resolved => {
			slot.access = resolved;
			this.dispatch();
		});
		if (this.signal?.aborted) slot.admit?.();
	}

	private readonly dispatch = (): void => {
		if (this.signal?.aborted) {
			for (const waiter of this.executionWaiters.splice(0)) waiter.abort(this.signal.reason);
			for (const slot of this.unfinished) slot.admit?.();
			return;
		}

		const readers = new Set<string>();
		const writers = new Set<string>();
		let hasEarlier = false;
		for (const slot of this.unfinished) {
			if (slot.access === undefined) break; // Its classification may yet be exclusive.
			if (slot.access === "exclusive") {
				if (!hasEarlier) slot.admit?.();
				break;
			}

			const conflict = slot.access.some(file =>
				writers.has(file.path) || (file.mode === "write" && readers.has(file.path)),
			);
			if (!conflict) slot.admit?.();
			// Queued calls reserve their position too: a later reader must wait for a queued writer.
			for (const file of slot.access) {
				const paths = file.mode === "read" ? readers : writers;
				paths.add(file.path);
			}
			hasEarlier = true;
		}
	};

	/** Called after approval; waiting for user input does not occupy any execution capacity. */
	async withExecutionSlot<R>(run: () => Promise<R>): Promise<R> {
		this.signal?.throwIfAborted();
		if (this.activeExecutions < MAX_CONCURRENT_EXECUTIONS) {
			this.activeExecutions++;
		} else {
			await new Promise<void>((enter, abort) => this.executionWaiters.push({ enter, abort }));
		}
		try {
			this.signal?.throwIfAborted();
			return await run();
		} finally {
			const next = this.executionWaiters.shift();
			if (next) next.enter(); // Transfer this occupied slot before new arrivals can claim it.
			else this.activeExecutions--;
		}
	}

	async finish(): Promise<T[]> {
		this.closed = true;
		try {
			const outcomes = await Promise.all(this.outcomes);
			return outcomes.map(outcome => {
				if (outcome.status === "rejected") throw outcome.reason;
				return outcome.value;
			});
		} finally {
			this.signal?.removeEventListener("abort", this.dispatch);
		}
	}
}
