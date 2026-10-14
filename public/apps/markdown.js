/* A small, safe Markdown subset rendered to DOM nodes (never innerHTML): paragraphs, lists, code, bold, italics, links. */

const SAFE_URL = /^(https?:|mailto:)/i;
// URL characters, allowing one level of balanced parentheses (e.g. https://en.wikipedia.org/wiki/Foo_(bar)).
const URL_CHARS = String.raw`(?:[^\s()<]|\([^\s()<]*\))+`;
const INLINE = [
  '(`[^`]+`)', // 1: code
  String.raw`(\*\*[^*]+\*\*)`, // 2: bold
  // 3: italics; underscores only at word boundaries, so snake_case identifiers stay intact
  String.raw`(\*[^*\s][^*]*\*|(?<![\p{L}\p{N}_])_[^_\s][^_]*_(?![\p{L}\p{N}_]))`,
  String.raw`(\[[^\]]+\]\(${URL_CHARS}\))`, // 4: [label](url)
  String.raw`(https?://${URL_CHARS})`, // 5: bare URL
].join('|');

function link(parent, label, href) {
  if (SAFE_URL.test(href)) parent.append(Object.assign(document.createElement('a'), { href, target: '_blank', rel: 'noopener noreferrer', textContent: label }));
  else parent.append(label);
}

function inline(text, parent) {
  const re = new RegExp(INLINE, 'gu');
  let last = 0;
  for (let m; (m = re.exec(text));) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    let [tok] = m;
    if (m[1]) parent.append(Object.assign(document.createElement('code'), { textContent: tok.slice(1, -1) }));
    else if (m[2]) inline(tok.slice(2, -2), parent.appendChild(document.createElement('strong')));
    else if (m[3]) inline(tok.slice(1, -1), parent.appendChild(document.createElement('em')));
    else if (m[4]) {
      const sep = tok.indexOf('](');
      link(parent, tok.slice(1, sep), tok.slice(sep + 2, -1));
    } else {
      tok = tok.replace(/[.,;:!?'"]+$/, ''); // sentence punctuation after a bare URL is not part of it
      re.lastIndex = m.index + tok.length;
      link(parent, tok, tok);
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
