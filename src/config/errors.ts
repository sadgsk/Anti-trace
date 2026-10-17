/** Expected, user-correctable configuration failure. CLI boundaries must keep the REPL alive. */
export class ByokConfigError extends Error {
	override name = "ByokConfigError";
}
