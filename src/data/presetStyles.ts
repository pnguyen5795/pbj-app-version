// Placeholder "saved style" presets referenced by the Results screen's
// style picker. Swap for real user-saved styles later.

export interface PresetStyle {
  id: string;
  name: string;
  emoji: string;
  description: string;
}

export const PRESET_STYLES: PresetStyle[] = [
  { id: "preset_cinematic", name: "Cinematic Warm", emoji: "🎬", description: "Slow Cuts, Warm Grade" },
  { id: "preset_vlog", name: "Fast Vlog Cuts", emoji: "⚡", description: "Punchy Jump Cuts" },
  { id: "preset_studio", name: "Clean Studio", emoji: "✨", description: "Minimal, Steady Pacing" },
  { id: "preset_retro", name: "Retro Film Grain", emoji: "📼", description: "Grainy, Nostalgic Tones" },
];
