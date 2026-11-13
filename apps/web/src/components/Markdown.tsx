/**
 * 轻量安全 Markdown（topic-ia S2.5）：解析成 React 节点，文本由 JSX 自动转义，
 * 无 dangerouslySetInnerHTML、无新依赖。支持：围栏代码块、行内 **粗体** *斜体* `代码` [链接](url)、
 * 无序/有序列表、段落换行。链接仅放行 http(s) 与相对路径。
 */
import React from 'react';

function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (/^\/(?!\/)/.test(u) || /^#[\w-]*$/.test(u)) return u;
  return null;
}

const INLINE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g;

function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const parts = text.split(INLINE);
  parts.forEach((p, i) => {
    if (!p) return;
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) {
      out.push(<strong key={i}>{p.slice(2, -2)}</strong>);
    } else if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
      out.push(
        <code key={i} className="rounded bg-black/10 px-1 py-0.5 text-[0.9em]">
          {p.slice(1, -1)}
        </code>,
      );
    } else if (p.startsWith('*') && p.endsWith('*') && p.length > 2) {
      out.push(<em key={i}>{p.slice(1, -1)}</em>);
    } else if (p.startsWith('[')) {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
      const href = m ? safeHref(m[2]) : null;
      if (m && href) {
        out.push(
          <a key={i} href={href} target="_blank" rel="noreferrer noopener" className="underline opacity-90">
            {m[1]}
          </a>,
        );
      } else {
        out.push(<span key={i}>{p}</span>);
      }
    } else {
      out.push(<span key={i}>{p}</span>);
    }
  });
  return out;
}

function renderBlock(block: string, key: number): React.ReactNode {
  const lines = block.split('\n');
  const nodes: React.ReactNode[] = [];
  let list: string[] = [];
  let listOrdered = false;
  let tableRows: string[][] = [];
  const flush = (k: string) => {
    if (!list.length) return;
    const items = list.map((t, i) => <li key={i}>{renderInline(t)}</li>);
    nodes.push(listOrdered ? <ol key={k} className="my-1 list-decimal pl-5">{items}</ol> : <ul key={k} className="my-1 list-disc pl-5">{items}</ul>);
    list = [];
  };
  const flushTable = (k: string) => {
    if (!tableRows.length) return;
    const [head, ...body] = tableRows;
    const rows = body.length && /^\s*\|?\s*:?-{3,}/.test(body[0].join('|')) ? body.slice(1) : body;
    nodes.push(
      <div key={k} className="my-1.5 overflow-x-auto">
        <table className="border-collapse text-[0.92em]">
          <thead>
            <tr>{head.map((c, i) => <th key={i} className="border border-black/15 px-2 py-1 text-left font-semibold">{renderInline(c)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, i) => <td key={i} className="border border-black/15 px-2 py-1">{renderInline(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    tableRows = [];
  };
  lines.forEach((line, i) => {
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const tr = /^\s*\|(.+)\|\s*$/.exec(line);
    if (tr) {
      flush(`f${key}-${i}`);
      tableRows.push(tr[1].split('|').map((c) => c.trim()));
      return;
    }
    flushTable(`t${key}-${i}`);
    if (ul || ol) {
      const isOl = !!ol;
      if (list.length && listOrdered !== isOl) flush(`f${key}-${i}`);
      listOrdered = isOl;
      list.push((ul ?? ol)![1]);
      return;
    }
    flush(`f${key}-${i}`);
    if (line.trim()) nodes.push(<div key={`l${key}-${i}`} className="my-0.5">{renderInline(line)}</div>);
  });
  flush(`f${key}-end`);
  flushTable(`t${key}-end`);
  return <React.Fragment key={key}>{nodes}</React.Fragment>;
}

export function Markdown({ text }: { text: string }) {
  const segs = text.split(/```[\w-]*\n?([\s\S]*?)```/g);
  return (
    <div className="whitespace-pre-wrap break-words">
      {segs.map((seg, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="my-1.5 overflow-x-auto rounded-[10px] bg-black/10 p-2 text-[0.85em]">
            <code>{seg.replace(/\n$/, '')}</code>
          </pre>
        ) : (
          renderBlock(seg, i)
        ),
      )}
    </div>
  );
}
