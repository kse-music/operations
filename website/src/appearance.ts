// Development uses two origins. Carry the non-sensitive preference when navigating between them.
export function carryAppearance(event: MouseEvent) {
  if (!import.meta.env.DEV || !(event.target instanceof Element)) return;
  const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
  if (!anchor) return;
  const target = new URL(anchor.href);
  if (
    target.origin !== location.origin &&
    ['127.0.0.1', 'localhost'].includes(target.hostname) &&
    ['4180', '4181'].includes(target.port)
  ) {
    target.searchParams.set(
      '_theme',
      document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    );
    anchor.href = target.href;
  }
}
