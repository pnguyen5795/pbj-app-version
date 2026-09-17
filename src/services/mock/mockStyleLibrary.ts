import type { SavedStyle, MediaKind } from "../../types";
import type { StyleLibraryService } from "../interfaces";
import { delay, makeId } from "../../utils/id";

// A couple of seeded entries so the library doesn't look empty on first
// visit. No real file backs these — they render via `thumbColor` instead
// of `previewUrl` (see StyleLibrary screen).
const SEED: SavedStyle[] = [
  {
    id: makeId("style"),
    name: "Golden Hour Beach",
    kind: "video",
    previewUrl: "",
    thumbColor: "linear-gradient(160deg, #f2a65a, #8b5cf6)",
    createdAt: new Date().toISOString(),
  },
  {
    id: makeId("style"),
    name: "Fast Vlog Cuts",
    kind: "video",
    previewUrl: "",
    thumbColor: "linear-gradient(160deg, #8b5cf6, #6c8dff)",
    createdAt: new Date().toISOString(),
  },
];

/**
 * In-memory stand-in for the Style Library backend. A real implementation
 * would persist saved clips server-side and kick off async style
 * analysis on `add` (see StyleLibraryService doc comment) — this keeps
 * the same shape so swapping it in later is a one-file change.
 */
export class MockStyleLibraryService implements StyleLibraryService {
  private items: SavedStyle[] = [...SEED];

  async list(): Promise<SavedStyle[]> {
    await delay(300);
    return [...this.items];
  }

  async add(
    file: { fileName: string; previewUrl: string; kind: MediaKind },
    styleName: string
  ): Promise<SavedStyle> {
    await delay(600 + Math.random() * 400);
    const entry: SavedStyle = {
      id: makeId("style"),
      name: styleName.trim() || file.fileName,
      kind: file.kind,
      previewUrl: file.previewUrl,
      createdAt: new Date().toISOString(),
    };
    this.items = [entry, ...this.items];
    return entry;
  }

  async remove(id: string): Promise<void> {
    await delay(200);
    this.items = this.items.filter((i) => i.id !== id);
  }
}
