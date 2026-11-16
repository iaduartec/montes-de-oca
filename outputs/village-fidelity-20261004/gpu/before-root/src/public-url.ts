/// <reference types="vite/client" />

/** Resolves a repository-root public path below Vite's configured base URL. */
export function publicUrl(path: string): string {
  const baseUrl = import.meta.env?.BASE_URL ?? '/';
  return `${baseUrl}${path.replace(/^\/+/, '')}`;
}
