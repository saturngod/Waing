import type { DesktopApi } from "@waing/ipc-contracts";

declare global {
  interface Window {
    waing: DesktopApi;
  }
}

export {};
