// A fast CommonMark 0.31.2 + GFM renderer that returns exactly the HTML
// marked 18.1.3 produces with its defaults (GFM on, breaks off, pedantic
// off, async off). Written from the CommonMark/GFM spec and from marked's
// observed output, case by case; where the two disagree, marked wins.
//
// How it works: a block pass splits the source into blocks (headings, code,
// lists, blockquotes, tables, paragraphs, ...) and an inline pass renders
// each block's text straight to HTML. There is no token tree for inline
// runs and no work shared between parse() calls: every call parses only
// the string it is given, and keeps nothing from an earlier call.
//
// Speed comes from the shape of the work: block rules match with sticky
// patterns at a cursor, the inline loop dispatches on the current character
// instead of trying every rule at every position, and the lexer advances by
// each block's raw length (the way marked's lexer does), so a block that
// stops early never swallows the lines after it.
'use strict';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeTestRe = /[&<>"']/;
const escapeReplaceRe = /[&<>"']/g;
const escapeTestNoEncodeRe = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncodeRe = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML the way marked's renderer does: with `encode` every one of
// the five characters is escaped; without it a bare & is left alone when it
// already starts a character reference.
function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (escapeTestRe.test(html)) return html.replace(escapeReplaceRe, (ch) => ESCAPE_MAP[ch]);
  } else if (escapeTestNoEncodeRe.test(html)) {
    return html.replace(escapeReplaceNoEncodeRe, (ch) => ESCAPE_MAP[ch]);
  }
  return html;
}

const numericRefRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericRefOrAmpRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Numeric character references name the character itself; a zero, an
// out-of-range value or a surrogate becomes the replacement character, and
// a bare & that cannot start a reference is escaped so it cannot join its
// neighbours into one.
function decodeNumericCharacterReferences(text) {
  if (!numericRefRe.test(text)) return text;
  return text.replace(numericRefOrAmpRe, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

const percentDecodeRe = /%25/g;
// Characters encodeURI leaves alone; a URL made only of them is already
// clean, and has no %25 for the second step to restore.
const cleanUrlSafeRe = /[^A-Za-z0-9;,\/?:@&=+$\-_.!~*'()#]/;
function cleanUrl(href) {
  if (!cleanUrlSafeRe.test(href)) return href;
  try {
    href = encodeURI(href).replace(percentDecodeRe, '%');
  } catch {
    return null;
  }
  return href;
}

// Split a table row on unescaped pipes, trimming the cells and honouring
// the leading/trailing pipe convention; `count` pads or cuts to the header
// width. An escaped pipe is kept as a literal pipe in the cell.
const findPipeRe = /\|/g;
const splitPipeRe = / \|/;
const slashPipeRe = /\\\|/g;
function splitCells(tableRow, count) {
  const row = tableRow.replace(findPipeRe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(splitPipeRe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1).trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(slashPipeRe, '|');
  return cells;
}

// Remove trailing 'c's (or, with invert, trailing non-'c's).
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

const blankLineRe = /^[ \t]*$/;
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && blankLineRe.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

const multipleSpaceRe = /\s+/g;
// A link label folds case through upper case (so ẞ meets SS) and collapses
// runs of spaces, tabs and line ends to one space.
function normalizeLabel(label) {
  return label.trim().replace(multipleSpaceRe, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the ')' that closes an unbalanced '(' run, -1 when balanced or
// absent, -2 when more '(' open than close.
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

// A tab runs to the next multiple-of-4 column from `indent`.
function expandTabs(line, indent) {
  indent = indent || 0;
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// Grammar: the block and inline patterns of the CommonMark + GFM grammar.
// Patterns are matched with the sticky flag at the lexer's cursor, so the
// source is never re-sliced as it is consumed. `Y` turns an anchored
// pattern into its sticky form: with `y` the match must start at lastIndex,
// so the leading `^` (and any `^` that starts an alternative) is redundant.
// ---------------------------------------------------------------------------

function Y(re, flags) {
  return new RegExp(re.source.replace(/(^|\|)\^/g, '$1'), 'y' + (flags || ''));
}

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// --- small shared patterns -------------------------------------------------
const codeRemoveIndentRe = /^(?: {0,3}\t| {1,4})/gm;
const outputLinkReplaceRe = /\\([\[\]])/g;
const indentCodeCompensationRe = /^(\s+)(?:```)/;
const beginningSpaceRe = /^\s+/;
const endingHashRe = /#$/;
const endingSpaceTabCharRe = /[ \t]$/;
const nonSpaceCharRe = /[^ ]/;
const newLineCharGlobalRe = /\n/g;
const tabCharGlobalRe = /\t/g;
const leadingSpaceTabRe = /^[ \t]+/;
const doubleBlankLineRe = /\n[ \t]*\n[ \t]*$/;
const blockquoteStartRe = /^ {0,3}>/;
const blockquoteSetextReplaceRe = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const blockquoteSetextReplace2Re = /^ {0,3}>[ \t]?/gm;
const blockquoteMarkerWhitespaceRe = /^( {0,3}>)([ \t]+)/gm;
const listIsTaskRe = /^\[[ xX]\][ \t]+\S/;
const listReplaceTaskRe = /^\[[ xX]\][ \t]+/;
const listTaskCheckboxRe = /\[[ xX]\]/;
const anyLineRe = /\n.*\n/;
const hrefBracketsRe = /^<(.*)>$/;
const tableDelimiterRe = /[:|]/;
const tableAlignCharsRe = /^\||\| *$/g;
const tableRowBlankLineRe = /\n[ \t]*$/;
const tableAlignRightRe = /^ *-+: *$/;
const tableAlignCenterRe = /^ *:-+: *$/;
const tableAlignLeftRe = /^ *:-+ *$/;
const startATagRe = /^<a /i;
const endATagRe = /^<\/a>/i;
const startPreScriptTagRe = /^<(pre|code|kbd|script)(\s|>)/i;
const endPreScriptTagRe = /^<\/(pre|code|kbd|script)(\s|>)/i;
const startAngleBracketRe = /^</;
const endAngleBracketRe = />$/;
const notSpaceStartRe = /^\S*/;
const endingNewlineRe = /\n$/;
const unicodeAlphaNumericRe = /[\p{L}\p{N}]/u;
const carriageReturnRe = /\r\n|\r/g;

// Indent-dependent helpers, cached per indent (0-3) because the block rules
// rebuild them for the current nesting depth.
function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}
const nextBulletRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`));
const headingBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}>`));
const listItemRegex = (bull) => Y(new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`));

// --- block rules (GFM) ------------------------------------------------------
const reNewline = Y(/^(?:[ \t]*(?:\n|$))+/);
const reBlockCode = Y(/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/);
const reFences = Y(/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/);
const reHr = Y(/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/);
const reHeading = Y(/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/);
const reList = Y(/^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/);
const reBlockquote = Y(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/);
const reHtml = Y(/^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/, 'i');
const reDef = Y(/^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/);
const reTable = Y(/^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/);
const reLheading = Y(/^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/);
const reParagraph = Y(/^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/);
const reBlockText = Y(/^[^\n]+/);

// --- inline rules (GFM) -----------------------------------------------------
const reEscape = Y(/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/);
const reInlineCode = Y(/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/);
const reBr = Y(/^( {2,}|\\)\n(?!\s*$)[ \t]*/);
const reEmStrongLDelim = Y(/^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/, 'u');
const reEmStrongRDelimAst = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const reEmStrongRDelimUnd = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const reDelLDelim = Y(/^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/, 'u');
const reDelRDelim = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const reAutolink = Y(/^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/);
const reUrl = Y(/^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/);
const reBackpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const reTag = Y(/^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/);
const reLink = Y(/^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/);
const reReflink = Y(/^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/);
const reNolink = Y(/^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/);
const reReflinkSearch = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const reBlockSkip = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const reAnyPunctuation = /\\([\p{P}\p{S}])/gu;
const reAnyPunctuationOutsideCode = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const rePunctuation = Y(/^((?![*_])[\s\p{P}\p{S}])/u, 'u');

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes (src, pos, ctx) and returns {token, end} or
// null. A token's `end` is always pos + token.raw.length: marked's lexer
// advances by the raw length, so a block that stops early (a blockquote
// whose last chunk is code, a list followed by blank lines, an HTML block
// with trailing blank lines) leaves the rest of the source for the next
// rule instead of swallowing it. `ctx` holds the parse state: links (link
// reference definitions), state.top, and the queue of inline runs
// (paragraph / text / heading / table-cell tokens, in tokenization order)
// that the task-checkbox pass needs to find again.
// ---------------------------------------------------------------------------

function execAt(re, src, pos) {
  re.lastIndex = pos;
  return re.exec(src);
}

// The next line of src starting at pos, without allocating the remainder.
function lineAt(src, pos) {
  const nl = src.indexOf('\n', pos);
  return nl === -1 ? src.slice(pos) : src.slice(pos, nl);
}

function indentCodeCompensation(raw, text) {
  const m = indentCodeCompensationRe.exec(raw);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mm = beginningSpaceRe.exec(node);
    if (mm === null) return node;
    return node.slice(Math.min(mm[0].length, indentToCode.length));
  }).join('\n');
}

function tokSpace(src, pos) {
  const cap = execAt(reNewline, src, pos);
  if (cap && cap[0].length > 0) return { token: { t: 'space', raw: cap[0] }, end: pos + cap[0].length };
  return null;
}

function tokCode(src, pos) {
  const cap = execAt(reBlockCode, src, pos);
  if (!cap) return null;
  const raw = trimTrailingBlankLines(cap[0]);
  const text = raw.replace(codeRemoveIndentRe, '');
  return { token: { t: 'code', raw, text, lang: undefined }, end: pos + raw.length };
}

function tokFences(src, pos) {
  const cap = execAt(reFences, src, pos);
  if (!cap) return null;
  const raw = cap[0];
  const text = indentCodeCompensation(raw, cap[3] || '');
  const lang = cap[2] ? cap[2].trim().replace(reAnyPunctuation, '$1') : cap[2];
  return { token: { t: 'code', raw, text, lang }, end: pos + raw.length };
}

function tokHeading(src, pos) {
  const cap = execAt(reHeading, src, pos);
  if (!cap) return null;
  let text = cap[2].trim();
  if (endingHashRe.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || endingSpaceTabCharRe.test(trimmed)) text = trimmed.trim();
  }
  const raw = rtrim(cap[0], '\n');
  return { token: { t: 'heading', raw, depth: cap[1].length, text }, end: pos + raw.length };
}

function tokHr(src, pos) {
  const cap = execAt(reHr, src, pos);
  if (!cap) return null;
  const raw = rtrim(cap[0], '\n');
  return { token: { t: 'hr', raw }, end: pos + raw.length };
}

function tokHtml(src, pos) {
  const cap = execAt(reHtml, src, pos);
  if (!cap) return null;
  const raw = trimTrailingBlankLines(cap[0]);
  return { token: { t: 'html', raw, pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style', text: raw }, end: pos + raw.length };
}

function tokDef(src, pos) {
  const cap = execAt(reDef, src, pos);
  if (!cap) return null;
  if (!startAngleBracketRe.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return null;
  const tag = normalizeLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(hrefBracketsRe, '$1').replace(reAnyPunctuation, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(reAnyPunctuation, '$1') : cap[3];
  const raw = rtrim(cap[0], '\n');
  return { token: { t: 'def', tag, raw, href, title }, end: pos + raw.length };
}

function tokTable(src, pos, ctx) {
  // A table's second line is its delimiter row, which always holds a `-`.
  const nl = src.indexOf('\n', pos);
  if (nl === -1) return null;
  const nl2 = src.indexOf('\n', nl + 1);
  const delimLine = nl2 === -1 ? src.slice(nl + 1) : src.slice(nl + 1, nl2);
  if (!delimLine.includes('-')) return null;
  const cap = execAt(reTable, src, pos);
  if (!cap) return null;
  if (!tableDelimiterRe.test(cap[2])) return null;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(tableAlignCharsRe, '').split('|');
  const rows = cap[3] && cap[3].trim() ? cap[3].replace(tableRowBlankLineRe, '').split('\n') : [];
  if (headers.length !== aligns.length) return null;
  const item = { t: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  for (const align of aligns) {
    if (tableAlignRightRe.test(align)) item.align.push('right');
    else if (tableAlignCenterRe.test(align)) item.align.push('center');
    else if (tableAlignLeftRe.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    const cell = { text: headers[i], header: true, align: item.align[i] };
    item.header.push(cell);
    ctx.inlineQueue.push(cell);
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => {
      const c = { text: cell, header: false, align: item.align[i] };
      ctx.inlineQueue.push(c);
      return c;
    }));
  }
  return { token: item, end: pos + item.raw.length };
}

// A setext heading needs a line of `=` or `-` under its text, before any
// blank line or a line that starts another block. This scan answers
// whether one could be there, line by line with plain character tests,
// so the setext pattern only runs when it has something to find. It is a
// necessary condition only: true does not mean the pattern matches.
function lheadingPossible(src, pos) {
  const len = src.length;
  let lineStart = pos;
  let first = true;
  while (lineStart < len) {
    const nl = src.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? len : nl;
    const line = src.slice(lineStart, lineEnd);
    // Leading spaces, capped at 4 (more than 3 already answers most tests).
    let sp = 0;
    while (sp < line.length && line.charCodeAt(sp) === 32 && sp < 4) sp++;
    const rest = line.slice(sp);
    if (first) {
      first = false;
      // The first line may not be blank, indented code, or a line that
      // starts another block. A thematic break is not one of those: a
      // line of `-` can still be setext text.
      if (line.length === 0) return false;
      if (sp >= 4 || (sp < line.length && line.charCodeAt(sp) === 9)) return false;
      if (isLheadingInterrupting(line, sp, rest, true)) return false;
    } else {
      if (isSetextUnderline(line, sp, rest)) return true;
      if (isBlankLine(line)) return false;
      if (isLheadingInterrupting(line, sp, rest, false)) return false;
    }
    if (nl === -1) return false;
    lineStart = nl + 1;
  }
  return false;
}

// A line that is only spaces/tabs (or empty).
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A setext underline: up to three spaces, then only `=` or only `-`.
function isSetextUnderline(line, sp, rest) {
  if (sp > 3 || rest.length === 0) return false;
  const mark = rest.charCodeAt(0);
  if (mark !== 61 && mark !== 45) return false;
  for (let i = 1; i < rest.length; i++) {
    const c = rest.charCodeAt(i);
    if (c !== mark && c !== 32 && c !== 9) return false;
  }
  return true;
}

// A line that starts a block the setext text cannot contain: a list item,
// a fence, a blockquote, an ATX heading, a thematic break, an HTML line,
// or a table delimiter row. `sp` is the leading-space count (capped at 4)
// and `rest` the line after them. A thematic break does not bar the first
// line, where it is ordinary text.
function isLheadingInterrupting(line, sp, rest, isFirst) {
  if (sp > 3) return false;
  if (rest.length === 0) return false;
  const c0 = rest.charCodeAt(0);
  // List marker: a bullet, or 1-9 digits and `.` / `)`, then a space.
  if (c0 === 42 || c0 === 43 || c0 === 45) {
    return rest.length > 1 && rest.charCodeAt(1) === 32;
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < rest.length && rest.charCodeAt(i) >= 48 && rest.charCodeAt(i) <= 57 && i < 9) i++;
    if (i > 0 && i < rest.length && (rest.charCodeAt(i) === 46 || rest.charCodeAt(i) === 41)
      && i + 1 < rest.length && rest.charCodeAt(i + 1) === 32) return true;
    return false;
  }
  // Fence: three or more backticks or tildes.
  if (c0 === 96 || c0 === 126) {
    let i = 0;
    while (i < rest.length && rest.charCodeAt(i) === c0) i++;
    return i >= 3;
  }
  // Blockquote.
  if (c0 === 62) return true;
  // ATX heading: 1-6 `#` followed by space, tab or the end of the line.
  if (c0 === 35) {
    let i = 0;
    while (i < rest.length && rest.charCodeAt(i) === 35 && i < 6) i++;
    return i >= 1 && i <= 6 && (i === rest.length || rest.charCodeAt(i) === 32 || rest.charCodeAt(i) === 9);
  }
  // Thematic break: only one of `-` / `_` / `*` and spaces/tabs, at least
  // three of the marker.
  if (c0 === 45 || c0 === 95 || c0 === 42) {
    if (isFirst) return false;
    let count = 0;
    for (let i = 0; i < rest.length; i++) {
      const c = rest.charCodeAt(i);
      if (c === c0) count++;
      else if (c !== 32 && c !== 9) return false;
    }
    return count >= 3;
  }
  // HTML line: `<...>` with the `>` last on the line.
  if (c0 === 60) {
    const gt = rest.indexOf('>');
    return gt > 1 && gt === rest.length - 1;
  }
  // Table delimiter row: only `:`, `-`, space and `|`, with a `|` in it.
  if (c0 === 124 || c0 === 58 || c0 === 45 || c0 === 32) {
    let pipe = false;
    for (let i = 0; i < rest.length; i++) {
      const c = rest.charCodeAt(i);
      if (c === 124) pipe = true;
      else if (c !== 58 && c !== 45 && c !== 32) return false;
    }
    return pipe;
  }
  return false;
}

function tokLheading(src, pos, ctx) {
  if (!lheadingPossible(src, pos)) return null;
  const cap = execAt(reLheading, src, pos);
  if (!cap) return null;
  const token = { t: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[2].charAt(0) === '=' ? 1 : 2, text: cap[1].trim() };
  ctx.inlineQueue.push(token);
  return { token, end: pos + token.raw.length };
}

function tokParagraph(src, pos, ctx) {
  const cap = execAt(reParagraph, src, pos);
  if (!cap) return null;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  const token = { t: 'paragraph', raw: cap[0], text };
  ctx.inlineQueue.push(token);
  return { token, end: pos + cap[0].length };
}

function tokText(src, pos, ctx) {
  const cap = execAt(reBlockText, src, pos);
  if (!cap) return null;
  const token = { t: 'text', raw: cap[0], text: cap[0] };
  ctx.inlineQueue.push(token);
  return { token, end: pos + cap[0].length };
}

// The block loop: tries the block rules in order at the cursor. Paragraphs
// only run at the top level; inside a list item `top` is false and bare
// lines become text tokens instead. An indented code block or a link
// definition that follows a paragraph or text is folded into it, the way
// marked folds them.
function blockTokens(src, tokens, lastParagraphClipped, ctx) {
  tokens = tokens || [];
  let pos = 0;
  let prevPos = -1;
  const len = src.length;
  while (pos < len) {
    if (pos === prevPos) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    prevPos = pos;
    // A block can only start with its own opening characters (each pattern
    // allows up to three leading spaces). Testing the first character once
    // skips the patterns that cannot match here.
    const c = src.charCodeAt(pos);
    const isSpace = c === 32;
    let r;

    if ((c === 10 || c === 9 || isSpace) && (r = tokSpace(src, pos))) {
      pos = r.end;
      const lastToken = tokens.at(-1);
      if (r.token.raw.length === 1 && lastToken !== undefined) lastToken.raw += '\n';
      else tokens.push(r.token);
      continue;
    }
    if ((c === 9 || isSpace) && (r = tokCode(src, pos))) {
      pos = r.end;
      const lastToken = tokens.at(-1);
      if (lastToken && (lastToken.t === 'paragraph' || lastToken.t === 'text')) {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + r.token.raw;
        lastToken.text += '\n' + r.token.text;
      } else tokens.push(r.token);
      continue;
    }
    if ((c === 96 || c === 126 || isSpace) && (r = tokFences(src, pos))) {
      pos = r.end;
      tokens.push(r.token);
      continue;
    }
    if ((c === 35 || isSpace) && (r = tokHeading(src, pos))) {
      pos = r.end;
      ctx.inlineQueue.push(r.token);
      tokens.push(r.token);
      continue;
    }
    if ((c === 45 || c === 95 || c === 42 || isSpace) && (r = tokHr(src, pos))) {
      pos = r.end;
      tokens.push(r.token);
      continue;
    }
    if ((c === 62 || isSpace) && (r = tokBlockquote(src, pos, ctx))) {
      pos = r.end;
      tokens.push(r.token);
      continue;
    }
    if ((c === 42 || c === 43 || c === 45 || (c >= 48 && c <= 57) || isSpace) && (r = tokList(src, pos, ctx))) {
      pos = r.end;
      tokens.push(r.token);
      continue;
    }
    if ((c === 60 || isSpace) && (r = tokHtml(src, pos))) {
      pos = r.end;
      tokens.push(r.token);
      continue;
    }
    if ((c === 91 || isSpace) && (r = tokDef(src, pos))) {
      pos = r.end;
      const lastToken = tokens.at(-1);
      if (lastToken && (lastToken.t === 'paragraph' || lastToken.t === 'text')) {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + r.token.raw;
        lastToken.text += '\n' + r.token.raw;
      } else {
        if (!ctx.links[r.token.tag]) {
          ctx.links[r.token.tag] = { href: r.token.href, title: r.token.title };
          ctx.hasLinks = true;
        }
        tokens.push(r.token);
      }
      continue;
    }
    if ((r = tokTable(src, pos, ctx))) {
      pos = r.end;
      tokens.push(r.token);
      continue;
    }
    if ((r = tokLheading(src, pos, ctx))) {
      pos = r.end;
      tokens.push(r.token);
      continue;
    }
    if (ctx.state.top && (r = tokParagraph(src, pos, ctx))) {
      const lastToken = tokens.at(-1);
      if (lastParagraphClipped && lastToken && lastToken.t === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + r.token.raw;
        lastToken.text += '\n' + r.token.text;
        ctx.inlineQueue.pop();
      } else tokens.push(r.token);
      lastParagraphClipped = false;
      pos = r.end;
      continue;
    }
    if ((r = tokText(src, pos, ctx))) {
      const lastToken = tokens.at(-1);
      if (lastToken && lastToken.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + r.token.raw;
        lastToken.text += '\n' + r.token.text;
        ctx.inlineQueue.pop();
      } else tokens.push(r.token);
      pos = r.end;
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  ctx.state.top = true;
  return tokens;
}

function tokBlockquote(src, pos, ctx) {
  const cap = execAt(reBlockquote, src, pos);
  if (!cap) return null;
  // Lines are the regex match without its trailing newlines; the token's
  // raw is built from the lines actually consumed, so the lexer restarts
  // right after the last one.
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (blockquoteStartRe.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else break;
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      // a tab after the marker runs to the next tab stop; the marker only
      // consumes one space of it, the rest is content
      .replace(blockquoteMarkerWhitespaceRe, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      // precede a lazy setext continuation with 4 spaces so it is not a setext
      .replace(blockquoteSetextReplaceRe, '\n    $1')
      .replace(blockquoteSetextReplace2Re, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;

    const top = ctx.state.top;
    ctx.state.top = true;
    blockTokens(currentText, tokens, true, ctx);
    ctx.state.top = top;

    if (lines.length === 0) break;
    const lastToken = tokens.at(-1);
    if (lastToken && (lastToken.t === 'code' || lastToken.t === 'heading' || lastToken.t === 'hr' || lastToken.t === 'html' || lastToken.t === 'table')) {
      break;
    } else if (lastToken && lastToken.t === 'blockquote') {
      const oldToken = lastToken;
      // The continuation lines belong to the same nesting frame as the nested
      // blockquote, which already had one '>' stripped, so strip one from
      // them too; otherwise a restated marker after a lazy line is re-parsed
      // as a spurious deeper blockquote.
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(blockquoteSetextReplace2Re, '');
      const newToken = tokBlockquote(newText, 0, ctx).token;
      tokens[tokens.length - 1] = newToken;
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && blockquoteStartRe.test(lines[0])) continue;
      break;
    } else if (lastToken && lastToken.t === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokList(newText, 0, ctx).token;
      tokens[tokens.length - 1] = newToken;
      // The list raw has no '>' markers, so it cannot be cut out of `raw`.
      // Count the continuation lines the list took and add those instead.
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  return { token: { t: 'blockquote', raw, tokens, text }, end: pos + raw.length };
}

// Whether `raw` ends with two blank lines (a blank line, then a line that
// is blank or only spaces/tabs): the list-loose test, without a regex over
// the whole item.
function endsWithDoubleBlank(raw) {
  let e = raw.length;
  while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
  if (e === 0 || raw[e - 1] !== '\n') return false;
  e--;
  while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
  return e > 0 && raw[e - 1] === '\n';
}

// The column of the first non-space character, counting each tab as four
// columns (the way the list rule's `line.replace(/\t/g, '    ')` counts
// it): only the >= 4 outcome is ever used, and the two counts agree on it.
function firstNonSpaceCol(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4;
    else break;
  }
  return col;
}

function tokList(src, pos, ctx) {
  const cap0 = execAt(reList, src, pos);
  if (!cap0) return null;
  const startPos = pos;
  let bull = cap0[1].trim();
  const isordered = bull.length > 1;
  const list = {
    t: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = listItemRegex(bull);
  let endsWithBlankLine = false;
  let p = pos;

  while (p < src.length) {
    let endEarly = false;
    let itemContents = '';
    itemRegex.lastIndex = p;
    const cap = itemRegex.exec(src);
    if (!cap) break;
    if (execAt(reHr, src, p)) break;

    const itemStart = p;
    p = itemRegex.lastIndex;
    const cap2 = cap[2];
    const nlIdx = cap2.indexOf('\n');
    const firstLine = nlIdx === -1 ? cap2 : cap2.slice(0, nlIdx);
    const bulletIndent = cap[1].length;
    // Expand a leading tab in the first line; spaces pass through unchanged.
    let line = firstLine;
    if (line.includes('\t')) line = firstLine.replace(leadingSpaceTabRe, (ws) => expandTabs(ws, bulletIndent));
    let nextLine = lineAt(src, p);
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(nonSpaceCharRe);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && blankLineRe.test(nextLine)) {
      p += nextLine.length + 1;
      endEarly = true;
    }

    if (!endEarly) {
      const nextBulletRe = nextBulletRegex(indent);
      const hrRe = hrRegex(indent);
      const fencesBeginRe = fencesBeginRegex(indent);
      const headingBeginRe = headingBeginRegex(indent);
      const htmlBeginRe = htmlBeginRegex(indent);
      const blockquoteBeginRe = blockquoteBeginRegex(indent);

      while (p < src.length) {
        const rawLine = lineAt(src, p);
        nextLine = rawLine;
        // The first non-space character decides whether this line can start
        // a new block at all; most continuation lines start with a letter
        // and skip all six tests. Tabs in the leading whitespace are
        // expanded; spaces pass through unchanged.
        let wi = 0;
        let hasTab = false;
        while (wi < nextLine.length) {
          const c = nextLine.charCodeAt(wi);
          if (c === 32) wi++;
          else if (c === 9) { hasTab = true; wi++; }
          else break;
        }
        const fc = wi < nextLine.length ? nextLine.charCodeAt(wi) : 0;
        const canBreak = fc === 96 || fc === 126 || fc === 35 || fc === 60 || fc === 62
          || fc === 42 || fc === 43 || fc === 45 || fc === 95 || (fc >= 48 && fc <= 57);
        if (canBreak) {
          if (fencesBeginRe.test(nextLine)) break;
          if (headingBeginRe.test(nextLine)) break;
          if (htmlBeginRe.test(nextLine)) break;
          if (blockquoteBeginRe.test(nextLine)) break;
          if (nextBulletRe.test(nextLine)) break;
          if (hrRe.test(nextLine)) break;
        }
        const nextLineWithoutTabs = hasTab
          ? nextLine.replace(leadingSpaceTabRe, (ws) => expandTabs(ws))
          : nextLine;

        if (nextLineWithoutTabs.search(nonSpaceCharRe) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if (firstNonSpaceCol(line) >= 4) break;
          if (fencesBeginRe.test(line)) break;
          if (headingBeginRe.test(line)) break;
          if (htmlBeginRe.test(line)) break;
          if (hrRe.test(line)) break;
          // A lazy continuation can look like a setext underline after list
          // indentation is removed. Keep it in the paragraph.
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && execAt(reLheading, `${line}\n${nextLine}`, 0) !== null;
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }

        blankLine = !nextLine.trim();
        p = Math.min(src.length, p + rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }

    const raw = src.slice(itemStart, p);

    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (endsWithDoubleBlank(raw)) endsWithBlankLine = true;
    }

    list.items.push({
      t: 'list_item',
      raw,
      task: listIsTaskRe.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }

  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return null;
  }
  // The raw is trimmed of trailing blank lines, and the lexer advances by
  // its length: the blank lines after the last item belong to whatever
  // follows the list, and a blank line between items is what makes the
  // list loose.
  list.raw = src.slice(startPos, p).trimEnd();

  // Item child tokens are handled here at the end, because the final item had
  // to be trimmed first. First pass: tokenize items and finalize list.loose
  // from spacers, before placing checkboxes.
  for (const item of list.items) {
    ctx.state.top = false;
    item.tokens = blockTokens(item.text, [], false, ctx);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.t === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => anyLineRe.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }

  // Second pass: place task checkboxes using the final list.loose.
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken && (itemToken.t === 'text' || itemToken.t === 'paragraph'))) {
      item.text = item.text.replace(listReplaceTaskRe, '');
      itemToken.raw = itemToken.raw.replace(listReplaceTaskRe, '');
      itemToken.text = itemToken.text.replace(listReplaceTaskRe, '');
      for (let i = ctx.inlineQueue.length - 1; i >= 0; i--) {
        if (listIsTaskRe.test(ctx.inlineQueue[i].text)) {
          ctx.inlineQueue[i].text = ctx.inlineQueue[i].text.replace(listReplaceTaskRe, '');
          break;
        }
      }
      const taskRaw = listTaskCheckboxRe.exec(item.raw);
      if (taskRaw) {
        const checkboxToken = { t: 'checkbox', raw: taskRaw[0] + ' ', checked: taskRaw[0] !== '[ ]' };
        item.checked = checkboxToken.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].t)) {
            item.tokens[0].pre = checkboxToken;
          } else {
            item.tokens.unshift({ t: 'paragraph', raw: checkboxToken.raw, text: checkboxToken.raw, pre: checkboxToken });
            ctx.inlineQueue.push(item.tokens[0]);
          }
        } else {
          item.tokens.unshift(checkboxToken);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.t === 'text') token.t = 'paragraph';
      }
    }
  }

  return { token: list, end: startPos + list.raw.length };
}

// ---------------------------------------------------------------------------
// Inline lexing. One pass over an inline run renders straight to HTML (or,
// for image alt text, to plain text); the tokenization decisions are the
// same in both modes, only the rendering differs (mode 0 = HTML, 1 = text).
// Every tokenizer works on the full run at an absolute cursor: no
// `src.slice(pos)` on the hot path, so a long run costs linear time, not
// quadratic.
// ---------------------------------------------------------------------------

function linkInText(text, ctx) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(reBlockSkip)) {
    if (execAt(reLink, match[0], 0) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(reReflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), ctx)) continue;
    return true;
  }
  return false;
}

// Last position of each emphasis delimiter in the masked source; emStrong
// and del use these to bound the window they scan for a closer.
function scanClosers(masked) {
  return { star: masked.lastIndexOf('*'), und: masked.lastIndexOf('_'), del: masked.lastIndexOf('~') };
}

// Mask links, code spans, HTML and escapes so emphasis and strikethrough do
// not see their delimiters inside them. Every mask keeps the length it
// replaces: emStrong and del line the masked source up with the real one.
// When the run holds none of the things that need masking, the source is
// already its own mask.
function maskSrc(src, ctx) {
  if (!src.includes('[') && !src.includes('`') && !src.includes('<') && !src.includes('\\')) return src;
  let maskedSrc = src;
  if (src.includes('[') && ctx.hasLinks) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      // Links may not contain other links: a candidate whose text already
      // holds one never becomes a link, so flattening the whole span would
      // hide the emphasis that does still apply inside it. Mask the links
      // it holds instead. Images are exempt: their text is flattened.
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, ctx)) {
          return '[' + text.replace(reReflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reReflinkSearch, maskReflink);
  }
  if (src.includes('`') || src.includes('\\')) {
    maskedSrc = maskedSrc.replace(reAnyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(reBlockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return maskedSrc;
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = execAt(reInlineCode, label, i);
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = execAt(reTag, tokenSrc, 0) || execAt(reAutolink, tokenSrc, 0);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function outputLink(cap, link, ctx, mode) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(outputLinkReplaceRe, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const state = ctx.state;
  const outerInLink = state.inLink;
  const outerLinkEmitted = state.linkEmitted;
  const outerInRawBlock = state.inRawBlock;
  state.inLink = true;
  state.linkEmitted = false;
  const inner = inlineRun(text, ctx, isImage ? 1 : mode);
  const textHasLink = state.linkEmitted;
  state.linkEmitted = outerLinkEmitted;
  state.inLink = outerInLink;
  if (!isImage) {
    // Links may not contain other links, at any level of nesting. Bail so
    // the caller falls through to text and the inner link is the one kept.
    if (textHasLink) {
      state.inRawBlock = outerInRawBlock;
      return null;
    }
    state.linkEmitted = true;
  }
  if (isImage) {
    const cleanHref = cleanUrl(href);
    if (mode === 1) return inner;
    if (cleanHref === null) return escapeHtmlEntities(inner);
    let out = `<img src="${escapeHtmlEntities(cleanHref)}" alt="${escapeHtmlEntities(inner)}"`;
    if (title) out += ` title="${escapeHtmlEntities(title)}"`;
    return out + '>';
  }
  if (mode === 1) return inner;
  const parsedText = inner;
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return parsedText;
  let out = '<a href="' + escapeHtmlEntities(cleanHref) + '"';
  if (title) out += ' title="' + escapeHtmlEntities(title) + '"';
  return out + '>' + parsedText + '</a>';
}

function tokLink(src, pos, ctx, mode) {
  if (ctx.state.linkParenPossible === false) return null;
  const cap = execAt(reLink, src, pos);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], pos + labelStart)) return null;
  const trimmedUrl = cap[2].trim();
  if (startAngleBracketRe.test(trimmedUrl)) {
    if (!endAngleBracketRe.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // The ')' that ends the match is the link closer only when it is not
  // escaped: `[foo](/url\)` has no closer; that paren is destination text.
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (startAngleBracketRe.test(href)) href = href.slice(1, -1);
  const html = outputLink(cap, {
    href: href ? href.replace(reAnyPunctuation, '$1') : href,
    title: title ? title.replace(reAnyPunctuation, '$1') : title,
  }, ctx, mode);
  if (html === null) return null;
  return { html, end: pos + cap[0].length };
}

function tokReflink(src, pos, ctx, mode) {
  const cap = execAt(reReflink, src, pos) || execAt(reNolink, src, pos);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], pos + labelStart)) return null;
  const link = ctx.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    // An unresolved reference is just its first character as text.
    return { html: cap[0].charAt(0), end: pos + 1 };
  }
  const html = outputLink(cap, link, ctx, mode);
  if (html === null) return null;
  return { html, end: pos + cap[0].length };
}

// The number of code points in s (an astral character counts once, not
// twice as its two UTF-16 units would): the delimiter lengths in the
// emphasis rules count code points.
function codePointLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) i++;
    n++;
  }
  return n;
}
// The last code point of s (one or two UTF-16 units).
function lastCodePoint(s) {
  if (s.length === 0) return '';
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xDC00 && last <= 0xDFFF && s.length >= 2) return s.slice(-2);
  return s.slice(-1);
}

function tokEmStrong(src, pos, masked, closers, prevChar, ctx, mode) {
  const match = execAt(reEmStrongLDelim, src, pos);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;
  const delimChar = match[0][0];
  // A mid-run opener (for example the second star of an unmatched `**`) must
  // only pair with a delimiter that can only close, otherwise it steals the
  // opener of a later span (`**a*b*c` must be `**a<em>b</em>c`).
  const midRun = prevChar === delimChar;
  // The start of this delimiter run may already be behind the cursor, either
  // taken as text after the whole run failed to match or used to close an
  // earlier span. Flanking and rules 9-10 are about the whole run, so find
  // its start. The other delimiter character counts as punctuation here.
  const srcStart = pos;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runSlice = masked.slice(Math.max(0, runStart - 2), runStart);
  const runPrevChar = lastCodePoint(runSlice);
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!execAt(rePunctuation, runPrevChar, 0);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!execAt(rePunctuation, prevChar, 0);
  // _ can't be between two alphanumerics.
  if (match[4] && prevChar.match(unicodeAlphaNumericRe)) return null;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = codePointLength(match[0]) - 1;
    // Rules 9-10 count the whole run, and also apply when the opener could
    // close as well (`a*b**`, where `*` is both left- and right-flanking).
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? reEmStrongRDelimAst : reEmStrongRDelimUnd;
    const lastPossible = delimChar === '*' ? closers.star : closers.und;
    const windowStart = pos + lLength;
    if (lastPossible < windowStart) return null;
    // The closer scan runs on the window's slice: the first alternative is
    // anchored to the window start, so the slice is what anchors it.
    const maskedSlice = masked.slice(windowStart);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    let delimTotal = lLength;
    let midDelimTotal = 0;
    let m;
    while ((m = endReg.exec(maskedSlice)) !== null) {
      if (m.index > lastInWindow) break;
      const rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      let rLength = rDelim.length;
      if (m[3] || m[4]) {
        delimTotal += rLength;
        continue;
      } else if (m[5] || m[6] || openerCanClose) {
        if (midRun && (m[5] || m[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = m[0].charCodeAt(0) >= 0xD800 && m[0].charCodeAt(0) <= 0xDBFF && m[0].charCodeAt(1) >= 0xDC00 && m[0].charCodeAt(1) <= 0xDFFF ? 2 : 1;
      const rawEnd = pos + lLength + m.index + lastCharLength + rLength;
      const raw = src.slice(pos, rawEnd);
      if (Math.min(lLength, rLength) % 2) {
        const inner = inlineRun(raw.slice(1, -1), ctx, mode);
        return { html: mode === 0 ? `<em>${inner}</em>` : inner, end: rawEnd };
      }
      const inner = inlineRun(raw.slice(2, -2), ctx, mode);
      return { html: mode === 0 ? `<strong>${inner}</strong>` : inner, end: rawEnd };
    }
  }
  return null;
}

function tokDel(src, pos, masked, closers, prevChar, ctx, mode) {
  const match = execAt(reDelLDelim, src, pos);
  if (!match) return null;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || !!execAt(rePunctuation, prevChar, 0)) {
    const lLength = codePointLength(match[0]) - 1;
    let delimTotal = lLength;
    const endReg = reDelRDelim;
    const lastPossible = closers.del;
    const windowStart = pos + lLength;
    if (lastPossible < windowStart) return null;
    const maskedSlice = masked.slice(windowStart);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    let m;
    while ((m = endReg.exec(maskedSlice)) !== null) {
      if (m.index > lastInWindow) break;
      const rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      let rLength = rDelim.length;
      if (rLength !== lLength) continue;
      if (m[3] || m[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = m[0].charCodeAt(0) >= 0xD800 && m[0].charCodeAt(0) <= 0xDBFF && m[0].charCodeAt(1) >= 0xDC00 && m[0].charCodeAt(1) <= 0xDFFF ? 2 : 1;
      const rawEnd = pos + lLength + m.index + lastCharLength + rLength;
      const raw = src.slice(pos, rawEnd);
      const inner = inlineRun(raw.slice(lLength, -lLength), ctx, mode);
      return { html: mode === 0 ? `<del>${inner}</del>` : inner, end: rawEnd };
    }
  }
  return null;
}

function tokCodespan(src, pos) {
  const cap = execAt(reInlineCode, src, pos);
  if (!cap) return null;
  let text = cap[2].replace(newLineCharGlobalRe, ' ');
  const hasNonSpaceChars = nonSpaceCharRe.test(text);
  const hasSpaceCharsOnBothEnds = text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ';
  if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
  return { text, end: reInlineCode.lastIndex };
}

function tokAutolink(src, pos) {
  const cap = execAt(reAutolink, src, pos);
  if (!cap) return null;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  const end = reAutolink.lastIndex;
  return { text, href, end };
}

function tokUrl(src, pos) {
  const cap = execAt(reUrl, src, pos);
  if (!cap) return null;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    let c0 = cap[0];
    do {
      prevCapZero = c0;
      const m = reBackpedal.exec(c0);
      c0 = m ? m[0] : '';
    } while (prevCapZero !== c0);
    text = c0;
    href = cap[1] === 'www.' ? 'http://' + c0 : c0;
  }
  return { text, href, end: pos + text.length };
}

// --- the inline text scan -------------------------------------------------
// The text rule is the inline loop's workhorse: it consumes a run of plain
// text up to the next delimiter, URL, email or hard break. The scan below
// returns exactly the end the text pattern would match, char by char, and
// is much cheaper than running that pattern: the pattern's lookaheads
// re-scan the same text at every position, this scan does not.

const TEXT_STOP = new Uint8Array(128);
for (const c of [92, 60, 33, 91, 96, 42, 126, 95]) TEXT_STOP[c] = 1;
const EMAIL_CHAR = new Uint8Array(128);
for (let c = 48; c <= 57; c++) EMAIL_CHAR[c] = 1;
for (let c = 65; c <= 90; c++) EMAIL_CHAR[c] = 1;
for (let c = 97; c <= 122; c++) EMAIL_CHAR[c] = 1;
// The email characters, exactly as the text pattern lists them.
for (const c of [46, 33, 35, 36, 37, 38, 39, 42, 43, 47, 61, 63, 96, 123, 124, 125, 126, 45, 95]) EMAIL_CHAR[c] = 1;

function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function startsWithWordAt(src, k, word) {
  if (k + word.length > src.length) return false;
  for (let i = 0; i < word.length; i++) if (src.charCodeAt(k + i) !== word.charCodeAt(i)) return false;
  return true;
}
// Two or more spaces and a newline start at k: a hard break.
function isHardBreakAt(src, k) {
  const len = src.length;
  let s = k;
  while (s < len && src.charCodeAt(s) === 32) s++;
  return s - k >= 2 && s < len && src.charCodeAt(s) === 10;
}
// An email-character run followed by '@' starts at k.
function emailRunAt(src, k) {
  const len = src.length;
  let q = k;
  while (q < len) {
    const cq = src.charCodeAt(q);
    if (cq >= 128 || !EMAIL_CHAR[cq]) break;
    q++;
  }
  return q > k && q < len && src.charCodeAt(q) === 64;
}
// The next stop the text pattern can end at, found with one pattern
// search instead of one character at a time. It mirrors the scan: http,
// ftp, mailto and xmpp are case-insensitive there, while www. is
// lowercase-only.
const NEXT_TEXT_STOP_RE = /[\\<\[!`*~_]|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|www\.| {2,}\n|[mM][aA][iI][lL][tT][oO]:|[xX][mM][pP][pP]:/g;
// Where the text chunk starting at pos ends: the same end the text pattern
// matches, worked out one character at a time.
function scanTextEnd(src, pos) {
  const len = src.length;
  if (pos >= len) return pos;
  const hasAt = src.indexOf('@', pos) !== -1;
  // One non-alphanumeric character followed by mailto:/xmpp: is a chunk.
  const c0 = src.charCodeAt(pos);
  if (!isAlnumCode(c0) && (startsWithWordAt(src, pos + 1, 'mailto:') || startsWithWordAt(src, pos + 1, 'xmpp:'))) return pos + 1;
  // First group: a run of backticks, a run of tildes, or one other character.
  let i = pos;
  if (c0 === 96 || c0 === 126) {
    while (i < len && src.charCodeAt(i) === c0) i++;
  } else {
    i = pos + 1;
  }
  // Immediate stops right after the first group.
  if (i < len) {
    const ci = src.charCodeAt(i);
    if (ci === 96 || ci === 126) return i;
    if (isHardBreakAt(src, i)) return i;
    if (hasAt && emailRunAt(src, i)) return i;
  }
  // The earliest stop at or after i is the smaller of the email stop and
  // the pattern stop. The email stop is the start of the first email run
  // reaching an `@` after i, or i itself when the run started before i.
  let emailEnd = len;
  if (hasAt) {
    let at = src.indexOf('@', i);
    while (at !== -1) {
      let r = at - 1;
      while (r >= 0) {
        const cr = src.charCodeAt(r);
        if (cr >= 128 || !EMAIL_CHAR[cr]) break;
        r--;
      }
      r++;
      if (r < at && i < at) {
        emailEnd = Math.max(r, i);
        break;
      }
      at = src.indexOf('@', at + 1);
    }
  }
  let stopEnd = len;
  NEXT_TEXT_STOP_RE.lastIndex = i;
  let m;
  while ((m = NEXT_TEXT_STOP_RE.exec(src)) !== null) {
    const mp = m.index;
    const fc = m[0].charCodeAt(0);
    if (fc === 119) { // www.: only after whitespace, `*`, `_`, `~` or `(`
      if (mp === 0) { stopEnd = mp; break; }
      const p = src.charCodeAt(mp - 1);
      if (p === 32 || p === 9 || p === 10 || p === 13 || p === 42 || p === 95 || p === 126 || p === 40) { stopEnd = mp; break; }
      continue;
    }
    if (fc === 109 || fc === 120 || fc === 77 || fc === 88) { // mailto: / xmpp:
      // A mailto starting exactly at i is not a stop; before i it must
      // follow a non-alphanumeric character.
      if (mp === i) continue;
      if (mp > i && isAlnumCode(src.charCodeAt(mp - 1))) continue;
      stopEnd = mp;
      break;
    }
    if (fc === 32) { // hard break: two spaces and a newline
      if (mp >= i) { stopEnd = mp; break; }
      // The first group ate one space of this run. Three or more spaces
      // still end the chunk at i; two do not end it at all.
      let k = 0;
      while (src.charCodeAt(mp + k) === 32) k++;
      if (k >= 3) { stopEnd = i; break; }
      NEXT_TEXT_STOP_RE.lastIndex = mp + k + 1;
      continue;
    }
    stopEnd = mp;
    break;
  }
  return stopEnd < emailEnd ? stopEnd : emailEnd;
}

function tokInlineText(src, pos, ctx, mode) {
  const end = scanTextEnd(src, pos);
  if (end <= pos) return null;
  const raw = src.slice(pos, end);
  const escaped = ctx.state.inRawBlock;
  let html;
  if (mode === 0) html = escaped ? raw : escapeHtmlEntities(decodeNumericCharacterReferences(raw));
  else html = escaped ? raw : decodeNumericCharacterReferences(raw);
  return { html, raw, end };
}

// The inline pass over one run of inline source. `masked` hides link, code,
// HTML and escape delimiters from the emphasis scan; `closers` holds the one
// scan of it for the last closers, shared by every opener in the pass.
//
// The loop dispatches on the current character: only a handful of rules
// can start at any given character, so a text position tries two rules
// instead of ten. The text rule is what stops the run before each
// delimiter, so the dispatch only ever sees a delimiter start (or a
// position the text rule handed over, which falls straight through to
// text again).
function inlineRun(src, ctx, mode) {
  const state = ctx.state;
  const prevLinkParenPossible = state.linkParenPossible;
  state.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return inlineRunInner(src, ctx, mode);
  } finally {
    state.linkParenPossible = prevLinkParenPossible;
  }
}

function inlineRunInner(src, ctx, mode) {
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = hasDelim ? maskSrc(src, ctx) : src;
  const closers = hasDelim ? scanClosers(masked) : { star: -1, und: -1, del: -1 };
  const state = ctx.state;
  const len = src.length;
  let out = '';
  let prevChar = '';
  let keepPrevChar = false;
  let pos = 0;
  let prevPos = -1;
  while (pos < len) {
    if (pos === prevPos) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    prevPos = pos;
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    let r;
    const ch = src.charCodeAt(pos);
    if (ch === 92) { // backslash: an escape, or a hard break
      if ((r = execAt(reEscape, src, pos))) {
        const text = r[1];
        out += mode === 0 ? escapeHtmlEntities(text) : text;
        pos = reEscape.lastIndex;
        continue;
      }
      if ((r = execAt(reBr, src, pos))) {
        out += mode === 0 ? '<br>' : '';
        pos = reBr.lastIndex;
        continue;
      }
    } else if (ch === 60) { // <: an HTML tag, or an autolink
      if ((r = execAt(reTag, src, pos))) {
        const tag = r[0];
        if (!state.inLink && startATagRe.test(tag)) state.inLink = true;
        else if (state.inLink && endATagRe.test(tag)) state.inLink = false;
        if (!state.inRawBlock && startPreScriptTagRe.test(tag)) state.inRawBlock = true;
        else if (state.inRawBlock && endPreScriptTagRe.test(tag)) state.inRawBlock = false;
        out += tag;
        pos = reTag.lastIndex;
        continue;
      }
      if ((r = tokAutolink(src, pos))) {
        if (mode === 1) {
          out += r.text;
        } else {
          const parsedText = escapeHtmlEntities(r.text, true);
          const cleanHref = cleanUrl(r.href);
          if (cleanHref === null) out += parsedText;
          else out += `<a href="${escapeHtmlEntities(cleanHref, true)}">${parsedText}</a>`;
        }
        pos = r.end;
        continue;
      }
    } else if (ch === 91 || ch === 33) { // [ or !: a link or a reference link
      if ((r = tokLink(src, pos, ctx, mode))) {
        out += r.html;
        pos = r.end;
        continue;
      }
      if ((r = tokReflink(src, pos, ctx, mode))) {
        out += r.html;
        pos = r.end;
        continue;
      }
    } else if (ch === 42 || ch === 95) { // * or _: emphasis or strong
      if (hasDelim && (r = tokEmStrong(src, pos, masked, closers, prevChar, ctx, mode))) {
        out += r.html;
        pos = r.end;
        continue;
      }
    } else if (ch === 96) { // `: a code span
      if ((r = tokCodespan(src, pos))) {
        out += mode === 0 ? `<code>${escapeHtmlEntities(r.text, true)}</code>` : r.text;
        pos = r.end;
        continue;
      }
    } else if (ch === 126) { // ~: strikethrough
      if (hasDelim && (r = tokDel(src, pos, masked, closers, prevChar, ctx, mode))) {
        out += r.html;
        pos = r.end;
        continue;
      }
    } else if (ch === 32) { // space: a hard break (two spaces + newline)
      if ((r = execAt(reBr, src, pos))) {
        out += mode === 0 ? '<br>' : '';
        pos = reBr.lastIndex;
        continue;
      }
    } else if (!state.inLink && (r = tokUrl(src, pos))) {
      // A bare URL or email address. Only reachable for a character that
      // cannot start any other construct; the text rule stops before URLs.
      if (mode === 1) {
        out += r.text;
      } else {
        const parsedText = escapeHtmlEntities(r.text, true);
        const cleanHref = cleanUrl(r.href);
        if (cleanHref === null) out += parsedText;
        else out += `<a href="${escapeHtmlEntities(cleanHref, true)}">${parsedText}</a>`;
      }
      pos = r.end;
      continue;
    }
    if ((r = tokInlineText(src, pos, ctx, mode))) {
      out += r.html;
      if (r.raw.slice(-1) !== '_') prevChar = r.raw.slice(-1);
      keepPrevChar = true;
      pos = r.end;
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering. Block tokens render in order; an inline run is rendered when
// its block is reached, with the link definitions the whole document holds
// already collected. A run starts with inRawBlock cleared, as the lexer's
// queue processing does; inLink carries across runs, as marked leaves it.
// ---------------------------------------------------------------------------

function renderCheckbox(token) {
  return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderCode(token) {
  const langString = (token.lang || '').match(notSpaceStartRe)?.[0];
  const code = token.text ? token.text.replace(endingNewlineRe, '') + '\n' : '';
  if (!langString) return '<pre><code>' + escapeHtmlEntities(code, true) + '</code></pre>\n';
  return '<pre><code class="language-' + escapeHtmlEntities(langString) + '">'
    + escapeHtmlEntities(code, true) + '</code></pre>\n';
}

function renderInlineTop(text, ctx) {
  ctx.state.inRawBlock = false;
  return inlineRun(text, ctx, 0);
}

function renderTableCell(cell, ctx) {
  const content = renderInlineTop(cell.text, ctx);
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderTable(token, ctx) {
  let cell = '';
  for (const h of token.header) cell += renderTableCell(h, ctx);
  const header = `<tr>\n${cell}</tr>\n`;
  let body = '';
  for (const row of token.rows) {
    cell = '';
    for (const c of row) cell += renderTableCell(c, ctx);
    body += `<tr>\n${cell}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}

function renderList(token, ctx) {
  let body = '';
  for (const item of token.items) body += `<li>${renderTokens(item.tokens, ctx)}</li>\n`;
  const type = token.ordered ? 'ol' : 'ul';
  const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderTokens(tokens, ctx) {
  let out = '';
  for (const token of tokens) {
    switch (token.t) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${token.depth}>${renderInlineTop(token.text, ctx)}</h${token.depth}>\n`;
        break;
      case 'code':
        out += renderCode(token);
        break;
      case 'table':
        out += renderTable(token, ctx);
        break;
      case 'blockquote':
        out += `<blockquote>\n${renderTokens(token.tokens, ctx)}</blockquote>\n`;
        break;
      case 'list':
        out += renderList(token, ctx);
        break;
      case 'checkbox':
        out += renderCheckbox(token);
        break;
      case 'html':
        out += token.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += `<p>${token.pre ? renderCheckbox(token.pre) : ''}${renderInlineTop(token.text, ctx)}</p>\n`;
        break;
      case 'text':
        out += (token.pre ? renderCheckbox(token.pre) : '') + renderInlineTop(token.text, ctx);
        break;
      default:
        throw new Error('Token with "' + token.t + '" type was not found.');
    }
  }
  return out;
}

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const src = markdown.replace(carriageReturnRe, '\n');
  const ctx = {
    links: Object.create(null),
    hasLinks: false,
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
    inlineQueue: [],
  };
  const tokens = blockTokens(src, [], false, ctx);
  return renderTokens(tokens, ctx);
}
