import type { ModuleId } from "./types";

export const MODULE_ORDER: ModuleId[] = [
  "foundation", "apiary", "factory", "comb", "bifrost", "demerzel",
];

/** Each module: label + a small emblem (inner SVG for a 0 0 40 40 viewBox). */
export const MODULES: Record<ModuleId, { nm: string; role: string; ver: string; emblem: string }> = {
  foundation: { nm: "foundation", role: "the seam", ver: "substrate",
    emblem: '<path d="M9 15h22M9 20h22M9 25h22M17 11v18M23 11v18"/>' },
  apiary: { nm: "apiary", role: "the conversation", ver: "v1.13.3",
    emblem: '<path d="M11 12h18a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-9l-5 4v-4h-4a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3z"/><circle cx="16" cy="18.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="20" cy="18.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="24" cy="18.5" r="1.3" fill="currentColor" stroke="none"/>' },
  factory: { nm: "factory", role: "the floor", ver: "CLI",
    emblem: '<circle cx="20" cy="20" r="6.5"/><path d="M20 9v4M20 27v4M9 20h4M27 20h4M12.2 12.2l2.8 2.8M25 25l2.8 2.8M27.8 12.2 25 15M15 25l-2.8 2.8"/>' },
  comb: { nm: "comb", role: "the vault", ver: "v0.1.0",
    emblem: '<circle cx="20" cy="16" r="6"/><path d="M20 22v9M20 27h5"/><circle cx="20" cy="16" r="1.6" fill="currentColor" stroke="none"/>' },
  bifrost: { nm: "bifrost", role: "the bridge", ver: "v1.7.0",
    emblem: '<path d="M8 27 Q20 9 32 27"/><circle cx="8" cy="27" r="2.4" fill="currentColor" stroke="none"/><circle cx="32" cy="27" r="2.4" fill="currentColor" stroke="none"/>' },
  demerzel: { nm: "Demerzel", role: "the voice", ver: "local",
    emblem: '<path d="M7 20h3l3-8 3 15 3-20 3 24 3-15 2 4h6"/>' },
};
