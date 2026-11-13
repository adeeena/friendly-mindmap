import { RichDoc, RichNode } from './model';

const ALLOWED_NODES = new Set(['doc', 'paragraph', 'text', 'hardBreak']);
const ALLOWED_MARKS = new Set(['bold', 'italic', 'underline', 'link']);

export function isSafeUrl(url: unknown): url is string {
  return typeof url === 'string' && /^(https?:|mailto:)/i.test(url.trim());
}

/** Drops unknown node types, marks, attributes and unsafe links. */
export function sanitizeRichDoc(input: unknown): RichDoc {
  const doc = sanitizeNode(input);
  if (!doc || doc.type !== 'doc') {
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }
  return doc as RichDoc;
}

function sanitizeNode(input: unknown): RichNode | null {
  if (!input || typeof input !== 'object') return null;
  const n = input as Record<string, unknown>;
  const type = n['type'];
  if (typeof type !== 'string' || !ALLOWED_NODES.has(type)) return null;
  const out: RichNode = { type };
  if (type === 'text') {
    if (typeof n['text'] !== 'string' || n['text'].length === 0) return null;
    out.text = n['text'];
    const marks = Array.isArray(n['marks']) ? n['marks'] : [];
    const cleanMarks: NonNullable<RichNode['marks']> = [];
    for (const m of marks) {
      if (!m || typeof m !== 'object') continue;
      const mt = (m as Record<string, unknown>)['type'];
      if (typeof mt !== 'string' || !ALLOWED_MARKS.has(mt)) continue;
      if (mt === 'link') {
        const href = ((m as Record<string, unknown>)['attrs'] as Record<string, unknown> | undefined)?.[
          'href'
        ];
        if (!isSafeUrl(href)) continue;
        cleanMarks.push({ type: 'link', attrs: { href } });
      } else {
        cleanMarks.push({ type: mt });
      }
    }
    if (cleanMarks.length) out.marks = cleanMarks;
    return out;
  }
  if (Array.isArray(n['content'])) {
    const content = n['content'].map(sanitizeNode).filter((c): c is RichNode => c !== null);
    if (content.length) out.content = content;
  }
  return out;
}

export function richToPlain(doc: RichDoc | undefined): string {
  if (!doc) return '';
  const paragraphs: string[] = [];
  for (const block of doc.content ?? []) {
    let line = '';
    for (const inline of block.content ?? []) {
      if (inline.type === 'text') line += inline.text ?? '';
      else if (inline.type === 'hardBreak') line += '\n';
    }
    paragraphs.push(line);
  }
  return paragraphs.join('\n');
}

export function isRichEmpty(doc: RichDoc | undefined): boolean {
  return richToPlain(doc).trim().length === 0;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Builds HTML only from allow-listed, escaped parts of a sanitized doc. */
export function richToHtml(doc: RichDoc | undefined): string {
  const clean = sanitizeRichDoc(doc);
  return (clean.content ?? [])
    .map((block) => `<p>${(block.content ?? []).map(inlineToHtml).join('')}</p>`)
    .join('');
}

function inlineToHtml(n: RichNode): string {
  if (n.type === 'hardBreak') return '<br>';
  let html = escapeHtml(n.text ?? '');
  for (const m of n.marks ?? []) {
    if (m.type === 'bold') html = `<strong>${html}</strong>`;
    else if (m.type === 'italic') html = `<em>${html}</em>`;
    else if (m.type === 'underline') html = `<u>${html}</u>`;
    else if (m.type === 'link' && isSafeUrl(m.attrs?.['href'])) {
      html = `<a href="${escapeHtml(String(m.attrs['href']))}" target="_blank" rel="noopener noreferrer">${html}</a>`;
    }
  }
  return html;
}

/** Markdown-ish flattening used by Mermaid/checklist exports. */
export function richToMarkdown(doc: RichDoc | undefined): string {
  const clean = sanitizeRichDoc(doc);
  return (clean.content ?? [])
    .map((block) =>
      (block.content ?? [])
        .map((n) => {
          if (n.type === 'hardBreak') return '\n';
          let t = n.text ?? '';
          for (const m of n.marks ?? []) {
            if (m.type === 'bold') t = `**${t}**`;
            else if (m.type === 'italic') t = `*${t}*`;
            else if (m.type === 'link') t = `[${t}](${String(m.attrs?.['href'])})`;
          }
          return t;
        })
        .join(''),
    )
    .join('\n');
}
