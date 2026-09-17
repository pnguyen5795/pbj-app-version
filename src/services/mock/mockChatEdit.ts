import type { EditPlan, TimelineClip, TransitionType } from "../../types";
import type { ChatEditService, ChatEditResult } from "../interfaces";
import type { ChatMessage } from "../../types";
import { delay, makeId } from "../../utils/id";

const ORDINALS: Record<string, number> = {
  first: 0,
  second: 1,
  third: 2,
  fourth: 3,
  fifth: 4,
  sixth: 5,
  seventh: 6,
  eighth: 7,
  ninth: 8,
  tenth: 9,
  last: -1,
};

/**
 * `contextIndex` is the clip the user was pointed at (via tapping the
 * video to pause, scrubbing the timeline, or tapping a clip) when they
 * issued the instruction. It's the fallback target for phrasing like
 * "extend this clip" or "add text here" that doesn't name a clip number.
 */
function resolveClipIndex(
  instruction: string,
  clipCount: number,
  contextIndex?: number | null
): number | null {
  const lower = instruction.toLowerCase();

  const numMatch = lower.match(/clip\s*#?(\d+)/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    return idx >= 0 && idx < clipCount ? idx : null;
  }

  for (const word of Object.keys(ORDINALS)) {
    if (lower.includes(word)) {
      const idx = ORDINALS[word];
      if (idx === -1) return clipCount - 1;
      return idx < clipCount ? idx : null;
    }
  }

  if (contextIndex !== undefined && contextIndex !== null && contextIndex < clipCount) {
    return contextIndex;
  }

  return null;
}

const TRANSITION_WORDS: { pattern: RegExp; type: TransitionType; label: string }[] = [
  { pattern: /whip/, type: "whip-pan", label: "whip" },
  { pattern: /fade|crossfade/, type: "crossfade", label: "fade" },
  { pattern: /zoom/, type: "zoom", label: "zoom" },
  { pattern: /slide/, type: "slide", label: "slide" },
  { pattern: /cut/, type: "cut", label: "cut" },
];

function retimeClips(clips: TimelineClip[]): TimelineClip[] {
  let cursor = 0;
  return clips.map((clip) => {
    const len = Math.max(0.3, clip.endSec - clip.startSec);
    const startSec = Math.round(cursor * 10) / 10;
    const endSec = Math.round((cursor + len) * 10) / 10;
    cursor = endSec;
    return { ...clip, startSec, endSec };
  });
}

/**
 * Stand-in for the "edit via chat" backend. Uses lightweight pattern
 * matching over the instruction text to mutate the current plan, so the
 * timeline visibly reacts. A real implementation would route this through
 * an LLM tool-calling loop against the render engine's edit primitives —
 * this class is the seam where that would plug in.
 */
export class MockChatEditService implements ChatEditService {
  async applyInstruction(
    plan: EditPlan,
    instruction: string,
    _history: ChatMessage[],
    contextClipId?: string | null
  ): Promise<ChatEditResult> {
    await delay(600 + Math.random() * 500);

    const lower = instruction.toLowerCase();
    let clips = plan.clips.map((c) => ({ ...c, overlays: [...c.overlays] }));
    let assistantReply = "";
    let styleSummary = plan.styleSummary;
    let pacing = plan.pacing;
    const contextIndex = contextClipId
      ? plan.clips.findIndex((c) => c.id === contextClipId)
      : null;

    if (/remove|delete|cut out/.test(lower)) {
      const idx = resolveClipIndex(instruction, clips.length, contextIndex);
      if (idx !== null && clips.length > 1) {
        const removed = clips[idx];
        clips.splice(idx, 1);
        clips = retimeClips(clips);
        assistantReply = `Removed "${removed.label}" from the timeline. Now ${clips.length} clips.`;
      } else {
        assistantReply = "I couldn't tell which clip to remove, or it's the only one left — try \"remove clip 2\".";
      }
    } else if (/longer|extend|stretch/.test(lower)) {
      const idx = resolveClipIndex(instruction, clips.length, contextIndex);
      if (idx !== null) {
        const clip = clips[idx];
        const len = clip.endSec - clip.startSec;
        const newLen = Math.round(len * 1.5 * 10) / 10;
        clips[idx] = {
          ...clip,
          endSec: clip.startSec + newLen,
          sourceOutSec: clip.sourceOutSec + (newLen - len),
        };
        clips = retimeClips(clips);
        assistantReply = `Made "${clip.label}" longer (${len.toFixed(1)}s → ${newLen.toFixed(1)}s).`;
      } else {
        assistantReply = "Which clip should I extend? Try \"make clip 2 longer\".";
      }
    } else if (/shorter|trim|shorten/.test(lower)) {
      const idx = resolveClipIndex(instruction, clips.length, contextIndex);
      if (idx !== null) {
        const clip = clips[idx];
        const len = clip.endSec - clip.startSec;
        const newLen = Math.max(0.5, Math.round(len * 0.6 * 10) / 10);
        clips[idx] = {
          ...clip,
          endSec: clip.startSec + newLen,
          sourceOutSec: clip.sourceInSec + newLen,
        };
        clips = retimeClips(clips);
        assistantReply = `Trimmed "${clip.label}" down (${len.toFixed(1)}s → ${newLen.toFixed(1)}s).`;
      } else {
        assistantReply = "Which clip should I trim? Try \"make clip 2 shorter\".";
      }
    } else if (/text overlay|caption|overlay saying|add text/.test(lower)) {
      const textMatch =
        instruction.match(/saying\s+["“]?([^"”]+)["”]?$/i) ||
        instruction.match(/["“]([^"”]+)["”]/);
      const text = textMatch ? textMatch[1].trim() : "your text here";
      const idx = resolveClipIndex(instruction, clips.length, contextIndex) ?? 0;
      const clip = clips[idx];
      clip.overlays = [
        ...clip.overlays,
        {
          id: makeId("ov"),
          text,
          position: "bottom",
          startSec: clip.startSec,
          endSec: Math.min(clip.endSec, clip.startSec + 2.5),
        },
      ];
      assistantReply = `Added the caption "${text}" over "${clip.label}".`;
    } else if (/faster|speed up|punchier|snappier/.test(lower)) {
      clips = clips.map((c) => {
        const len = c.endSec - c.startSec;
        const newLen = Math.max(0.5, len * 0.8);
        return { ...c, endSec: c.startSec + newLen };
      });
      clips = retimeClips(clips);
      assistantReply = "Tightened the pacing across the whole edit.";
    } else if (/reorder|swap|move clip/.test(lower)) {
      if (clips.length > 1) {
        const [first, second, ...rest] = clips;
        clips = [second, first, ...rest];
        clips = retimeClips(clips);
        assistantReply = `Swapped the order of "${first.label}" and "${second.label}".`;
      } else {
        assistantReply = "There's only one clip, nothing to reorder yet.";
      }
    } else if (/transition/.test(lower)) {
      const match = TRANSITION_WORDS.find((w) => w.pattern.test(lower));
      if (match) {
        clips = clips.map((c, i) => (i === 0 ? c : { ...c, transitionIn: match.type }));
        assistantReply = `Switched to ${match.label} transitions throughout.`;
      } else {
        assistantReply =
          "Which transition? Try \"use whip transitions\", \"use fade transitions\", or \"use zoom transitions\".";
      }
    } else if (/apply|match/.test(lower) && /style|look|aesthetic/.test(lower)) {
      const nameMatch = instruction.match(/(?:apply|match)(?: the)?\s+([a-zA-Z0-9 ]+?)\s+(?:style|look|aesthetic)/i);
      const name = nameMatch ? nameMatch[1].trim() : "reference";
      styleSummary = `Matched to the ${name} style — adjusted pacing and color mood to fit.`;
      const nameLower = name.toLowerCase();
      pacing = /vlog|fast|punchy/.test(nameLower)
        ? "punchy"
        : /cinematic|slow|calm/.test(nameLower)
          ? "slow"
          : pacing;
      assistantReply = `Applied the ${name} style across the edit.`;
    } else {
      assistantReply =
        "Got it — noted. Try things like \"remove clip 3\", \"make the second clip longer\", or \"add text overlay saying weekend vibes\".";
    }

    const updatedPlan: EditPlan = {
      ...plan,
      clips,
      styleSummary,
      pacing,
      targetDurationSec: clips.length
        ? Math.round(clips[clips.length - 1].endSec)
        : plan.targetDurationSec,
    };

    return { plan: updatedPlan, assistantReply };
  }
}
