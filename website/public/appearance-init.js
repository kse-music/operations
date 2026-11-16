(() => {
  const key = 'vitepress-theme-appearance';
  let choice = 'dark';
  let storage;
  const url = new URL(location.href);
  const carried = url.searchParams.get('_theme');
  try {
    storage = localStorage;
    choice = storage.getItem(key) || 'dark';
    if (carried === 'dark' || carried === 'light') {
      choice = carried;
      storage.setItem(key, carried);
    }
  } catch {
    // A blocked preference store does not prevent reading or changing this page.
    if (carried === 'dark' || carried === 'light') choice = carried;
  }
  document.documentElement.classList.toggle(
    'dark',
    choice === 'dark' || (choice === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches),
  );
  if (carried === 'dark' || carried === 'light') {
    // Development may inject this script after the app has read its preference.
    if (storage)
      window.dispatchEvent(
        new StorageEvent('storage', { key, newValue: choice, storageArea: storage }),
      );
    url.searchParams.delete('_theme');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }
})();
