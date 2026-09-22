/** Compaction thresholds and how much recent context to keep. */
export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

export function shouldCompact(used: number, window: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) {
		return false;
	}
	return used > window - settings.reserveTokens;
}
