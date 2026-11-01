// Every frontend file must parse as an ES module, exactly as the browser loads it.
// (A stray "//" comment once swallowed half of capture.js and killed the phone camera.)
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, writeFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'jarvis-syntax-'));
for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
  test(`${file} parses as an ES module`, () => {
    const copy = join(tmp, file.replace(/\.js$/, '.mjs'));
    writeFileSync(copy, readFileSync(join(dir, file)));
    const r = spawnSync(process.execPath, ['--check', copy], {encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr);
  });
}
