/** Positive means older content. Handle only wheel presses, never clicks or releases. */
export function mouseWheelDirection(raw: string): number {
	const sgr = /^\x1b\[<(\d+);\d+;\d+M$/.exec(raw);
	const button = sgr ? Number(sgr[1]) : raw.startsWith("\x1b[M") && raw.length >= 6 ? raw.charCodeAt(3) - 32 : -1;
	if (button < 0 || !(button & 64) || (button & 3) > 1) return 0;
	return (button & 3) === 0 ? 1 : -1;
}
