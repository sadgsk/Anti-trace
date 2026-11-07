import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { UiLocale, translate } from "../../cli/locale.ts";
const fallback = { subscribe: (_listener: () => void) => () => {}, getSnapshot: () => "zh" as const };
const Context = createContext<Pick<UiLocale,"subscribe" | "getSnapshot">>(fallback);
export function LocaleProvider({ locale, children }: { locale: Pick<UiLocale, "subscribe" | "getSnapshot">; children: ReactNode }) { return <Context.Provider value={locale}>{children}</Context.Provider>; }
export function useLocale() { const locale = useContext(Context), language = useSyncExternalStore(locale.subscribe, locale.getSnapshot, locale.getSnapshot); return { language, t: (text: string) => translate(text, language) }; }
