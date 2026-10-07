/** Keep desktop protocols on Windows; the Web host exposes authenticated HTTP resources. */
export function browserResourceUrl(url: string, web: boolean): string {
  return web && /^(?:local-sticker|moment-media):\/\//.test(url)
    ? `/api/core/resource?url=${encodeURIComponent(url)}` : url;
}
