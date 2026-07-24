import type { Program } from "../ast/nodes.js";
import type { SourceSpan } from "../diagnostics/diagnostic.js";
import type { SourceComment } from "../lexer/comments.js";

export type { SourceComment };

export interface CommentAttachments {
  readonly leading: Map<object, SourceComment[]>;
  readonly trailing: Map<object, SourceComment[]>;
  readonly eof: SourceComment[];
}

interface NodeSpan {
  readonly node: object;
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Attach lexed comments to AST nodes by source adjacency.
 * Leading: comments immediately before a node.
 * Trailing: same-line comments after a node's end.
 * Remaining comments after the last node become eof comments.
 */
export function attachComments(
  program: Program,
  comments: readonly SourceComment[],
): CommentAttachments {
  const leading = new Map<object, SourceComment[]>();
  const trailing = new Map<object, SourceComment[]>();
  const eof: SourceComment[] = [];

  if (comments.length === 0) {
    return { leading, trailing, eof };
  }

  const nodes = collectNodes(program).sort((a, b) => a.start - b.start || a.end - b.end);
  let nodeIndex = 0;

  for (const comment of comments) {
    const cStart = comment.span.start.offset;
    const cEnd = comment.span.end.offset;
    const cLine = comment.span.start.line;

    while (nodeIndex < nodes.length && nodes[nodeIndex]!.end <= cStart) {
      nodeIndex += 1;
    }

    let trailingOwner: NodeSpan | null = null;
    for (let i = nodeIndex - 1; i >= 0; i--) {
      const n = nodes[i]!;
      if (n.end > cStart) {
        continue;
      }
      if (n.endLine === cLine) {
        trailingOwner = n;
      }
      break;
    }

    if (trailingOwner) {
      push(trailing, trailingOwner.node, comment);
      continue;
    }

    let leadingOwner: NodeSpan | null = null;
    for (let i = nodeIndex; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.start >= cEnd) {
        // Prefer the outermost node among those that share this start offset
        // (e.g. ExpressionStatement over CallExpression over Identifier).
        let best = n;
        for (let j = i + 1; j < nodes.length; j++) {
          const other = nodes[j]!;
          if (other.start !== n.start) {
            break;
          }
          if (other.end >= best.end) {
            best = other;
          }
        }
        leadingOwner = best;
        break;
      }
    }

    if (leadingOwner) {
      push(leading, leadingOwner.node, comment);
    } else {
      eof.push(comment);
    }
  }

  return { leading, trailing, eof };
}

function push(
  map: Map<object, SourceComment[]>,
  node: object,
  comment: SourceComment,
): void {
  const list = map.get(node);
  if (list) {
    list.push(comment);
  } else {
    map.set(node, [comment]);
  }
}

function collectNodes(program: Program): NodeSpan[] {
  const out: NodeSpan[] = [];
  visit(program, out);
  return out;
}

function visit(node: unknown, out: NodeSpan[]): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.kind === "string" && isSpan(obj.span)) {
    const span = obj.span;
    out.push({
      node: obj,
      start: span.start.offset,
      end: span.end.offset,
      startLine: span.start.line,
      endLine: span.end.line,
    });
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, out);
      }
    } else if (value && typeof value === "object") {
      visit(value, out);
    }
  }
}

function isSpan(value: unknown): value is SourceSpan {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const s = value as SourceSpan;
  return (
    typeof s.start?.offset === "number" &&
    typeof s.end?.offset === "number" &&
    typeof s.start?.line === "number" &&
    typeof s.end?.line === "number"
  );
}

/** Format a comment at the given indent. Never rewrite comment contents. */
export function printComment(comment: SourceComment, indent: string): string {
  if (comment.kind === "line") {
    return `${indent}${comment.text}`;
  }
  const lines = comment.text.split("\n");
  if (lines.length === 1) {
    return `${indent}${comment.text}`;
  }
  return lines
    .map((line, i) => (i === 0 ? `${indent}${line}` : `${indent}${line.trimStart()}`))
    .join("\n");
}
