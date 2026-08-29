// entities.ts — HTML entity decoding for text exports.
//
// Rich-text editors store typographic punctuation as named entities, so pages
// carry raw `&mdash;` / `&ldquo;` / `&rsquo;` into every text export — ampersand
// soup an agent has to read through. Numeric forms decode generically; the named
// table covers what wiki corpora actually use (punctuation, arrows, maths,
// accented Latin, Greek) rather than attempting the full HTML5 list.

export const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•', sect: '§', para: '¶', dagger: '†',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  times: '×', divide: '÷', minus: '−', plusmn: '±', ne: '≠', le: '≤', ge: '≥',
  asymp: '≈', radic: '√', infin: '∞', sum: '∑', prod: '∏', int: '∫', deg: '°', permil: '‰',
  sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾',
  euro: '€', pound: '£', yen: '¥', cent: '¢', copy: '©', reg: '®', trade: '™',
  eacute: 'é', egrave: 'è', ecirc: 'ê', aacute: 'á', agrave: 'à', acirc: 'â', aring: 'å',
  auml: 'ä', ouml: 'ö', uuml: 'ü', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  ccedil: 'ç', oslash: 'ø', szlig: 'ß', aelig: 'æ',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ',
  mu: 'μ', nu: 'ν', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω',
  Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Lambda: 'Λ', Phi: 'Φ', Pi: 'Π',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_m, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d{1,7});/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,9});/g, (m, name: string) => NAMED_ENTITIES[name] ?? m);
}
