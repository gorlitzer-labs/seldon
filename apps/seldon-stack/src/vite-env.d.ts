/// <reference types="vite/client" />
declare module "*?raw" { const s: string; export default s; }
declare module "*/avatar.js" {
  export function createAvatar(canvas: HTMLCanvasElement): {
    setState(s: string): void;
    setLevel(v: number): void;
    setSpectrum(bins: unknown): void;
    dispose(): void;
  };
}
