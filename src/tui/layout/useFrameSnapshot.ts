import { useMemo, useSyncExternalStore } from "react";

/** UI subscribers see the newest state once per frame. Controllers/non-TTY consumers stay synchronous. */
export function useFrameSnapshot<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T {
	const store = useMemo(() => {
		let snapshot = getSnapshot();
		return {
			getSnapshot: () => snapshot,
			subscribe: (notify: () => void) => {
				let timer: NodeJS.Timeout | undefined;
				const update = () => { timer ??= setTimeout(() => { timer = undefined; snapshot = getSnapshot(); notify(); }, 16); };
				const unsubscribe = subscribe(update);
				// An event may have arrived between render and subscription.
				if (snapshot !== getSnapshot()) update();
				return () => { unsubscribe(); if (timer) clearTimeout(timer); };
			},
		};
	}, [subscribe, getSnapshot]);
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
