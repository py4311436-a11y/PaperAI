/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * "1" only in the `automation` build. Gates the `window.__paperai` test
   * bridge (K-03): the release build must not contain it.
   */
  readonly VITE_PAPERAI_AUTOMATION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
