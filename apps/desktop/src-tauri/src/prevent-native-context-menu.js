/* global document */
// Cancel the browser menu without stopping application contextmenu handlers.
document.addEventListener('contextmenu', (event) => event.preventDefault(), { capture: true });
