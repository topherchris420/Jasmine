/* A small, safe Markdown subset rendered to DOM nodes (never innerHTML): paragraphs, lists, code, bold, italics, links. */

const SAFE_URL = /^(https?:|mailto:)/i;

function inline(text, parent) {
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<)]+)/g;
  let last = 0;
  for (let m; (m = re.exec(text));) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const [tok] = m;
    if (m[1]) parent.append(Object.assign(document.createElement('code'), { textContent: tok.slice(1, -1) }));
    else if (m[2]) inline(tok.slice(2, -2), parent.appendChild(document.createElement('strong')));
    else if (m[3]) inline(tok.slice(1, -1), parent.appendChild(document.createElement('em')));
    else {
      const link = m[4] ? /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok) : [tok, tok, tok];
      const href = link[2];
      if (SAFE_URL.test(href)) {
        const a = Object.assign(document.createElement('a'), { href, target: '_blank', rel: 'noopener noreferrer', textContent: link[1] });
        parent.append(a);
      } else parent.append(link[1]);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

export function renderMarkdown(source) {
  const root = document.createDocumentFragment();
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      const pre = document.createElement('pre');
      pre.append(Object.assign(document.createElement('code'), { textContent: code.join('\n') }));
      root.append(pre);
      continue;
    }
    const bullet = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length && (ordered ? numbered : bullet).test(lines[i])) {
        const li = document.createElement('li');
        inline(lines[i].replace(ordered ? numbered : bullet, ''), li);
        list.append(li);
        i++;
      }
      root.append(list);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i])) para.push(lines[i++].replace(/^#{1,6}\s+/, ''));
    const p = document.createElement('p');
    para.forEach((l, j) => {
      if (j) p.append(document.createElement('br'));
      inline(l, p);
    });
    root.append(p);
  }
  return root;
}
