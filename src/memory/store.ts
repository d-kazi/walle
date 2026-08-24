import fs from 'node:fs';
import path from 'node:path';
import type { Child, MemoryScope, User } from '../types/domain.js';
import { CHILDREN } from '../types/domain.js';

/**
 * Markdown memory files under DATA_DIR/memory (PRD §4.3). Facts are bullets
 * with metadata: `- text {valid_from: YYYY-MM-DD}`; superseding rewrites the
 * old bullet with `{superseded: YYYY-MM-DD}` and appends the replacement.
 * Writes are atomic (tmp + rename). Superseded facts are never served to
 * context assembly.
 */

const CHILD_SECTIONS = ['## Quarter plan', '## Standing facts', '## Open'] as const;
export type ChildSection = (typeof CHILD_SECTIONS)[number];

export class MemoryStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'memory');
    fs.mkdirSync(path.join(this.dir, 'children'), { recursive: true });
    this.scaffold();
  }

  private scaffold(): void {
    const ensure = (rel: string, content: string) => {
      const p = path.join(this.dir, rel);
      if (!fs.existsSync(p)) fs.writeFileSync(p, content);
    };
    ensure('shared.md', '# Shared family memory\n\n');
    ensure('dan.private.md', '# Dan private\n\n');
    ensure('alina.private.md', '# Alina private\n\n');
    for (const child of CHILDREN) {
      const title = child.charAt(0).toUpperCase() + child.slice(1);
      let standing = '';
      if (child === 'dylan') {
        standing = '- ADHD: needs written reminders and single-step instructions {valid_from: 2026-08-24}\n';
      }
      ensure(
        path.join('children', `${child}.md`),
        `# ${title}\n\n## Quarter plan\n\n## Standing facts\n${standing}\n## Open\n\n`,
      );
    }
  }

  fileFor(scope: MemoryScope): string {
    switch (scope.kind) {
      case 'shared':
        return path.join(this.dir, 'shared.md');
      case 'private':
        return path.join(this.dir, `${scope.user}.private.md`);
      case 'child':
        return path.join(this.dir, 'children', `${scope.child}.md`);
    }
  }

  relFileFor(scope: MemoryScope): string {
    return path.relative(this.dir, this.fileFor(scope));
  }

  private write(file: string, content: string): void {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  }

  read(scope: MemoryScope): string {
    return fs.readFileSync(this.fileFor(scope), 'utf8');
  }

  /** Active bullets only — superseded lines are filtered out for good. */
  activeFacts(scope: MemoryScope): string[] {
    return this.read(scope)
      .split('\n')
      .filter((line) => line.trimStart().startsWith('- ') && !line.includes('{superseded:'))
      .map((line) => line.trim());
  }

  /** Child file content with superseded bullets removed, sections intact. */
  activeChildFile(child: Child): string {
    const content = fs.readFileSync(path.join(this.dir, 'children', `${child}.md`), 'utf8');
    return content
      .split('\n')
      .filter((line) => !line.includes('{superseded:'))
      .join('\n');
  }

  add(scope: MemoryScope, text: string, date: string, section?: ChildSection): void {
    const file = this.fileFor(scope);
    const bullet = `- ${text.trim()} {valid_from: ${date}}`;
    const content = fs.readFileSync(file, 'utf8');
    if (scope.kind === 'child') {
      const target: ChildSection = section ?? '## Open';
      this.write(file, insertInSection(content, target, bullet));
    } else {
      this.write(file, content.trimEnd() + '\n' + bullet + '\n');
    }
  }

  /**
   * Mark the first bullet containing `match` as superseded and append the
   * replacement. Returns false when no bullet matched.
   */
  supersede(
    scope: MemoryScope,
    match: string,
    replacement: string,
    date: string,
    section?: ChildSection,
  ): boolean {
    const file = this.fileFor(scope);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const idx = lines.findIndex(
      (line) =>
        line.trimStart().startsWith('- ') &&
        !line.includes('{superseded:') &&
        line.toLowerCase().includes(match.toLowerCase()),
    );
    if (idx === -1) return false;
    lines[idx] = `${lines[idx]} {superseded: ${date}}`;
    this.write(file, lines.join('\n'));
    this.add(scope, replacement, date, section);
    return true;
  }
}

function insertInSection(content: string, section: ChildSection, bullet: string): string {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l.trim() === section);
  if (start === -1) return content.trimEnd() + '\n' + bullet + '\n';
  // insert before the next section heading (or at end of file)
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) {
      end = i;
      break;
    }
  }
  // trim trailing blanks inside the section, keep one
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1]!.trim() === '') insertAt--;
  lines.splice(insertAt, 0, bullet);
  return lines.join('\n');
}
