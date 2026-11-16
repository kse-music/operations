export type Page = 'home' | 'privacy' | 'security' | 'not-found';

export function pageFromPath(path: string): Page {
  if (path === '/' || path === '/index.html') return 'home';
  if (path === '/privacy.html') return 'privacy';
  if (path === '/security.html') return 'security';
  return 'not-found';
}
