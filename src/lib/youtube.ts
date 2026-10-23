/**
 * Exercise videos are YouTube only (client workout experience R61): the client app plays them in
 * an embedded YouTube player. The same reading as vertice-mobile's `youtubeVideoId`
 * (`src/lib/video.ts`) and vertice-api's `YouTubeVideoUrlValidator`.
 */
const YOUTUBE_ID = /^[\w-]{11}$/

/** The 11-character video id of a YouTube watch/short/embed/live/youtu.be link, or null. */
export function youtubeVideoId(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const host = parsed.hostname.replace(/^(www|m)\./, '')
  let id: string | null = null
  if (host === 'youtu.be') {
    id = parsed.pathname.slice(1).split('/')[0] ?? null
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (parsed.pathname === '/watch') id = parsed.searchParams.get('v')
    else {
      const [, kind, value] = parsed.pathname.split('/')
      if (kind === 'shorts' || kind === 'embed' || kind === 'live') id = value ?? null
    }
  }
  return id !== null && YOUTUBE_ID.test(id) ? id : null
}
