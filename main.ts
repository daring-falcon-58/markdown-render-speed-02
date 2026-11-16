// Driver for the markdown-render-speed-02 entry. The harness runs
// `node main.ts` (node 22, type stripping, so only erasable syntax here:
// type annotations and `as` casts, no enums or parameter properties). It
// reads every case from $MAKEFUN_INPUT_DIR/cases.json (a JSON array of
// {id, markdown}), renders each one on its own with parse() from parse.js,
// and writes $MAKEFUN_OUTPUT_DIR/html.json: a JSON array of the HTML
// strings, one per case and in the cases' order. Outside a container the
// two environment variables stand in for /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Read the cases, render each alone, and keep the order.
const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
