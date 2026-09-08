import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('architecture README', () => {
  it('lists exactly the modules present in src/', () => {
    const readme = readFileSync(new URL('./ARCHITECTURE.md', import.meta.url), 'utf8');
    const documented = [...readme.matchAll(/^\| `([a-z]+)\/`/gm)].map((m) => m[1]).sort();
    const present = readdirSync(new URL('.', import.meta.url), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(documented).toEqual(present);
    for (const mod of present) {
      expect(readme, `diagram should mention ${mod}/`).toContain(`${mod}/`);
    }
  });
});
