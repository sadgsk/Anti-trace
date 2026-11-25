import { Children, type ReactNode } from "react";
import { Text } from "ink";
import { ThemedText } from "../theme/ThemeProvider.tsx";
export function Byline({ children }: { children: ReactNode }) {
	const items = Children.toArray(children).filter(child => child !== "");
	return items.length ? <ThemedText>{items.map((item, index) => <Text key={index}>{index ? " · " : ""}{item}</Text>)}</ThemedText> : null;
}
