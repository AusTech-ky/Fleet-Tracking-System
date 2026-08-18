import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Teltonika parameter catalogue exists twice: canonically in
 * packages/protocol-teltonika (native-TS ESM, tested there) and as a copy in
 * services/control-plane/src/protocol (this service is CommonJS + tsc and cannot
 * import the ESM package). This test makes the duplication safe: if the code
 * bodies ever differ, it fails, so a parameter ID can't be fixed in one place
 * and left wrong in the other — wrong IDs would be sent to real vehicles.
 */
/** Walk up from wherever this file runs (src/test or dist/test) to the repo root. */
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'packages', 'protocol-teltonika'))) return dir;
    dir = join(dir, '..');
  }
  throw new Error('repo root not found from ' + __dirname);
}

test('control-plane teltonika-params.ts is byte-identical to the canonical protocol package copy (below the header)', () => {
  const root = repoRoot();
  const canonical = readFileSync(join(root, 'packages', 'protocol-teltonika', 'src', 'params.ts'), 'utf8');
  const copy = readFileSync(join(root, 'services', 'control-plane', 'src', 'protocol', 'teltonika-params.ts'), 'utf8');
  // Compare from the first `export` onward — the leading doc comment differs by design.
  const body = (s: string) => s.slice(s.indexOf('\nexport ')).replace(/\r\n/g, '\n');
  assert.equal(body(copy), body(canonical), 'copies have drifted — re-copy from packages/protocol-teltonika/src/params.ts');
});
