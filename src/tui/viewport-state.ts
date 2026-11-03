/** Reading position belongs to a message, so expanding earlier messages does not move it. */
export interface TranscriptAnchor { id: number; row: number }
export interface ViewportMetrics { limit: number; offset: number; anchor?: TranscriptAnchor; lastTool?: TranscriptAnchor }
