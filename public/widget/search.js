/*
 * Jasmine search widget. Embed with:
 *   <div id="jasmine-search"></div>
 *   <script src="https://your-jasmine-host/widget/search.js" data-flow-id="my-flow" data-target="#jasmine-search" defer></script>
 * Optional: data-placeholder="Search the docs", data-color="#0b5d63".
 */
(() => {
  const script = document.currentScript;
  if (!script) return;
  const flowId = script.dataset.flowId;
  if (!flowId) return console.error('[jasmine] data-flow-id is required on the widget script tag');
  const base = new URL(script.src, location.href).origin;
  const target = (script.dataset.target && document.querySelector(script.dataset.target)) || script.parentElement;
  const params = new URLSearchParams();
  if (script.dataset.placeholder) params.set('placeholder', script.dataset.placeholder);
  if (script.dataset.color) params.set('color', script.dataset.color);
  const frame = document.createElement('iframe');
  frame.src = `${base}/apps/search/${encodeURIComponent(flowId)}${params.size ? `?${params}` : ''}`;
  frame.title = 'Search';
  frame.style.cssText = 'width:100%;height:120px;border:0;display:block;color-scheme:normal';
  target.append(frame);
  window.addEventListener('message', (e) => {
    if (e.origin === base && e.source === frame.contentWindow && e.data?.type === 'jasmine:height') frame.style.height = `${Math.min(4000, Math.max(80, Number(e.data.height) || 0))}px`;
  });
})();
