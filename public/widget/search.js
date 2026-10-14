/*
 * Jasmine search widget. Embed with:
 *   <div id="jasmine-search"></div>
 *   <script src="https://your-jasmine-host/widget/search.js" data-flow-id="my-flow" data-target="#jasmine-search" defer></script>
 * Optional: data-placeholder="Search the docs", data-color="#5b5bd6".
 */
(() => {
  const script = document.currentScript;
  if (!script) return;
  const flowId = script.dataset.flowId;
  if (!flowId) return console.error('[jasmine] data-flow-id is required on the widget script tag');
  const base = new URL(script.src, location.href).origin;
  const params = new URLSearchParams();
  if (script.dataset.placeholder) params.set('placeholder', script.dataset.placeholder);
  if (script.dataset.color) params.set('color', script.dataset.color);
  const frame = document.createElement('iframe');
  frame.src = `${base}/apps/search/${encodeURIComponent(flowId)}${params.size ? `?${params}` : ''}`;
  frame.title = 'Search';
  frame.style.cssText = 'width:100%;height:120px;border:0;display:block;color-scheme:normal';
  window.addEventListener('message', (e) => {
    if (e.origin === base && e.source === frame.contentWindow && e.data?.type === 'jasmine:height') frame.style.height = `${Math.min(4000, Math.max(80, Number(e.data.height) || 0))}px`;
  });
  // The target may come later in the page than a non-deferred script tag; a tag in <head> must never host the frame.
  const mount = () => {
    const parent = script.parentElement;
    const target = (script.dataset.target && document.querySelector(script.dataset.target)) || (parent && parent !== document.head ? parent : document.body);
    target.append(frame);
  };
  const ready = () => (script.dataset.target ? document.querySelector(script.dataset.target) : script.parentElement && script.parentElement !== document.head);
  if (document.readyState === 'loading' && !ready()) document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
