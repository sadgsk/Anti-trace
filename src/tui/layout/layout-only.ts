import { createContext } from "react";
/** Cached layouts must not retain timers or subscriptions to changing application state. */
export const LayoutOnlyContext = createContext(false);
