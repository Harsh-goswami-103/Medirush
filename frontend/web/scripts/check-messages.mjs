/**
 * Catalog lint: every message in en.json and hi.json must be valid ICU, and the
 * two must agree on arguments and rich-text tags.
 *
 * Typecheck already guarantees the *keys* match (src/i18n/types.ts). What it
 * cannot see is inside the strings — a dropped `{amount}` or a `<b>` that was
 * translated away produces a runtime error or mangled output in the one
 * language nobody on the team proof-reads. Hence a parser, not a regex: plural
 * branch bodies like `{Poor}` look exactly like arguments to a regex.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) =>
  JSON.parse(readFileSync(join(here, "..", "src", "messages", name), "utf8"));

const SUBMESSAGE_TYPES = new Set(["plural", "select", "selectordinal"]);

/**
 * Walks a message and collects argument names and tag names. `i` is an index
 * into `src`; `stop` ends the scan at an unmatched `}` so option bodies can
 * recurse. Throws on malformed ICU.
 */
function scan(src, i, stop, out) {
  while (i < src.length) {
    const ch = src[i];

    if (ch === "'" && src[i + 1] === "'") {
      i += 2; // escaped apostrophe
      continue;
    }
    if (ch === "}") {
      if (stop) return i;
      throw new Error(`unmatched '}' at ${i}`);
    }
    if (ch === "<") {
      const tag = /^<\/?([a-zA-Z][a-zA-Z0-9]*)\s*\/?>/.exec(src.slice(i));
      if (tag) {
        out.tags.add(tag[1]);
        i += tag[0].length;
        continue;
      }
    }
    if (ch !== "{") {
      i += 1;
      continue;
    }

    // ---- an argument -------------------------------------------------------
    let j = i + 1;
    while (j < src.length && /\s/.test(src[j])) j += 1;
    const nameStart = j;
    while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
    const name = src.slice(nameStart, j);
    if (!name) throw new Error(`empty argument name at ${i}`);
    out.args.add(name);
    while (j < src.length && /\s/.test(src[j])) j += 1;

    if (src[j] === "}") {
      i = j + 1;
      continue;
    }
    if (src[j] !== ",") throw new Error(`expected ',' or '}' after {${name}`);
    j += 1;
    while (j < src.length && /\s/.test(src[j])) j += 1;
    const typeStart = j;
    while (j < src.length && /[A-Za-z]/.test(src[j])) j += 1;
    const type = src.slice(typeStart, j);
    while (j < src.length && /\s/.test(src[j])) j += 1;

    if (!SUBMESSAGE_TYPES.has(type)) {
      // number/date/time — skip its style to the closing brace.
      let depth = 1;
      while (j < src.length && depth > 0) {
        if (src[j] === "{") depth += 1;
        else if (src[j] === "}") depth -= 1;
        j += 1;
      }
      i = j;
      continue;
    }

    if (src[j] !== ",") throw new Error(`expected ',' after ${type}`);
    j += 1;

    // ---- option bodies: `=1 {…} other {…}` ---------------------------------
    for (;;) {
      while (j < src.length && /\s/.test(src[j])) j += 1;
      if (src[j] === "}") {
        j += 1;
        break;
      }
      if (j >= src.length) throw new Error(`unterminated ${type}`);
      while (j < src.length && !/\s/.test(src[j]) && src[j] !== "{") j += 1;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      if (src[j] !== "{") throw new Error(`expected option body in ${type}`);
      j = scan(src, j + 1, true, out); // recurse: bodies may nest arguments
      j += 1; // consume the '}'
    }
    i = j;
  }
  if (stop) throw new Error("unterminated option body");
  return i;
}

function parse(message, label) {
  const out = { args: new Set(), tags: new Set() };
  try {
    scan(message, 0, false, out);
  } catch (err) {
    throw new Error(`${label}: ${err.message} — ${JSON.stringify(message)}`);
  }
  return out;
}

const en = load("en.json");
const hi = load("hi.json");
const problems = [];
let count = 0;

for (const ns of Object.keys(en)) {
  for (const [key, enMsg] of Object.entries(en[ns])) {
    const hiMsg = hi[ns]?.[key];
    const id = `${ns}.${key}`;
    if (typeof hiMsg !== "string") {
      problems.push(`${id}: missing in hi.json`);
      continue;
    }
    count += 1;
    let e;
    let h;
    try {
      e = parse(enMsg, `${id} [en]`);
      h = parse(hiMsg, `${id} [hi]`);
    } catch (err) {
      problems.push(err.message);
      continue;
    }
    const diff = (a, b) => [...a].filter((x) => !b.has(x));
    const argOnly = [...diff(e.args, h.args), ...diff(h.args, e.args)];
    if (argOnly.length) {
      problems.push(
        `${id}: argument mismatch — en {${[...e.args]}} vs hi {${[...h.args]}}`,
      );
    }
    const tagOnly = [...diff(e.tags, h.tags), ...diff(h.tags, e.tags)];
    if (tagOnly.length) {
      problems.push(`${id}: tag mismatch — en <${[...e.tags]}> vs hi <${[...h.tags]}>`);
    }
    if (!hiMsg.trim()) problems.push(`${id}: empty Hindi string`);
  }
}

// Extra Hindi keys are dead weight; typecheck catches them too, but a clear
// message here beats a structural type error.
for (const ns of Object.keys(hi)) {
  for (const key of Object.keys(hi[ns])) {
    if (en[ns]?.[key] === undefined) problems.push(`${ns}.${key}: present in hi.json only`);
  }
}

if (problems.length) {
  console.error(`${problems.length} problem(s) in the message catalogs:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`ok — ${count} message pairs, arguments and tags agree`);
