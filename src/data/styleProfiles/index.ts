import type { CreatorStyleProfile } from "./types";
import { TROY_OSTERBERG_STYLE } from "./troyOsterberg";
import { GENERIC_STYLE } from "./generic";

export type { CreatorStyleProfile, CutCategory, HoldSignal } from "./types";
export { TROY_OSTERBERG_STYLE, GENERIC_STYLE };

const CONFIRMED_PROFILES: CreatorStyleProfile[] = [TROY_OSTERBERG_STYLE];

/** Resolves which confirmed style profile applies, checking both the
 *  planner-resolved style name and the raw prompt (a creator can be named
 *  in either — e.g. a prompt reading "make this a Troy Osterberg style
 *  video" won't necessarily survive style-name extraction verbatim). */
export function resolveStyleProfile(styleName: string, prompt: string): CreatorStyleProfile {
  const haystack = `${styleName} ${prompt}`.toLowerCase();
  for (const profile of CONFIRMED_PROFILES) {
    if (profile.matchNames.some((name) => haystack.includes(name))) {
      return profile;
    }
  }
  return GENERIC_STYLE;
}
