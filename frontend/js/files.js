// Import de fichiers : lecture et analyse dans le navigateur (CSV, JSON, TXT).
//
// Le fichier complet ne passe jamais par le LLM (quota de tokens) : on lui envoie un
// résumé de sa structure, et les données entières sont injectées dans le widget sous
// window.PRISM_FILE (voir sandbox.js). Forme de PRISM_FILE : cf. engine/system-prompt.txt.

export const MAX_BYTES = 5 * 1024 * 1024;
const SUMMARY_BUDGET = 3800;
const EXT_KINDS = { csv: "csv", tsv: "csv", json: "json", geojson: "json", txt: "txt", md: "txt", log: "txt", text: "txt" };
const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${nf.format(bytes / 1024)} Ko`;
  return `${nf.format(bytes / 1024 / 1024)} Mo`;
}

export function kindOf(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (EXT_KINDS[ext]) return EXT_KINDS[ext];
  if (/json/i.test(file.type)) return "json";
  if (/csv/i.test(file.type)) return "csv";
  if (/^text\//i.test(file.type)) return "txt";
  return null;
}

/** File (glisser-déposer ou sélecteur) → pièce jointe analysée. */
export async function readAttachment(file) {
  const kind = kindOf(file);
  if (!kind) throw new Error(`format non pris en charge (${file.name}) : CSV, JSON ou TXT attendu`);
  if (file.size > MAX_BYTES) throw new Error(`fichier trop volumineux (${formatBytes(file.size)}, 5 Mo maximum)`);
  let text = await file.text();
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM UTF-8
  return parseAttachment(file.name, kind, text, file.size);
}

/** → { name, kind, size, meta (affichage), summary (pour le LLM), data (PRISM_FILE) } */
export function parseAttachment(name, kind, text, size = new Blob([text]).size) {
  if (kind === "csv") return csvAttachment(name, text, size);
  if (kind === "json") return jsonAttachment(name, text, size);
  return txtAttachment(name, text, size);
}

/** Ce qui part au moteur : jamais les données complètes. */
export function forRequest(attachment) {
  return attachment ? { name: attachment.name, kind: attachment.kind, summary: attachment.summary } : null;
}

function fit(lines) {
  let out = "";
  for (const line of lines) {
    if (out.length + line.length + 1 > SUMMARY_BUDGET) return `${out}…(tronqué)`;
    out += (out ? "\n" : "") + line;
  }
  return out;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// --------------------------------------------------------------------------
// CSV
// --------------------------------------------------------------------------
function countOutsideQuotes(line, delimiter) {
  let n = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === delimiter && !quoted) n += 1;
  }
  return n;
}

export function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 12);
  let best = ",";
  let bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    if (!counts[0]) continue;
    const score = counts.filter((c) => c === counts[0]).length * 1000 + counts[0];
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** Analyse RFC 4180 : guillemets, "" échappés, retours à la ligne dans les champs, CRLF.
 *  Découpe par tranches (slice) plutôt que caractère par caractère : peu d'allocations, donc peu de GC. */
export function parseCsv(text, delimiter) {
  const rows = [];
  const n = text.length;
  const d = delimiter.charCodeAt(0);
  const endOfField = (from) => {
    let k = from;
    while (k < n) {
      const c = text.charCodeAt(k);
      if (c === d || c === 10 || c === 13) break;
      k += 1;
    }
    return k;
  };
  let row = [];
  let i = 0;
  while (i < n) {
    let field;
    if (text.charCodeAt(i) === 34) {
      // Champ entre guillemets : on recolle les morceaux autour des "" échappés.
      const parts = [];
      let j = i + 1;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q === -1) { parts.push(text.slice(j)); j = n; break; }
        parts.push(text.slice(j, q));
        if (text.charCodeAt(q + 1) === 34) { parts.push('"'); j = q + 2; } else { j = q + 1; break; }
      }
      const k = endOfField(j);
      field = parts.join("") + text.slice(j, k);
      i = k;
    } else {
      const k = endOfField(i);
      field = text.slice(i, k);
      i = k;
    }
    row.push(field);
    if (i >= n) break;
    if (text.charCodeAt(i) === d) {
      i += 1;
      if (i >= n) row.push("");
      continue;
    }
    if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) i += 1;
    i += 1;
    rows.push(row);
    row = [];
  }
  if (row.length) rows.push(row);
  return rows.filter((r) => r.length > 1 || (r[0] || "").trim() !== "");
}

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && PLAIN_NUMBER.test(raw)) return Number(raw); // cas courant, sans allocation
  let t = String(raw).replace(/\s/g, "").replace(/^[€$£]|[€$£%]$/g, "");
  if (!t) return null;
  if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "").replace(",", "."); // 1.234,5
  else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, ""); // 1,234.5
  else if (/^[-+]?\d+,\d+$/.test(t)) t = t.replace(",", "."); // 12,5
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function parseDate(raw) {
  const t = String(raw || "").trim();
  let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[T ][\d:.]+Z?)?$/.exec(t);
  if (m) return t;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (!m) return null;
  let [, a, b, year] = m;
  // Jour en premier (usage français), sauf si c'est impossible.
  let day = Number(a);
  let month = Number(b);
  if (month > 12 && day <= 12) [day, month] = [month, day];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Type d'une colonne d'après un échantillon de 1 000 valeurs non vides au plus. */
function inferType(body, ci) {
  const sample = [];
  for (let r = 0; r < body.length && sample.length < 1000; r++) {
    const v = body[r][ci];
    if (v !== undefined && v.trim() !== "") sample.push(v);
  }
  if (!sample.length) return "text";
  if (sample.every((v) => parseNumber(v) !== null)) return "number";
  if (sample.every((v) => parseDate(v) !== null)) return "date";
  return "text";
}

function convert(raw, type) {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === "") return null;
  if (type === "number") return parseNumber(t);
  if (type === "date") return parseDate(t);
  return t;
}

function uniqueNames(header) {
  const seen = new Map();
  return header.map((h, i) => {
    let name = String(h).trim() || `colonne ${i + 1}`;
    const count = seen.get(name) || 0;
    seen.set(name, count + 1);
    if (count) name = `${name} (${count + 1})`;
    return name;
  });
}

/** Statistiques d'une colonne en une passe (pas de Math.min(...valeurs) : plafond d'arguments). */
function describeColumn(column, rows) {
  let count = 0;
  let min = null;
  let max = null;
  let sum = 0;
  const distinct = new Set();
  for (const row of rows) {
    const v = row[column.name];
    if (v === null) continue;
    count += 1;
    if (column.type === "number") sum += v;
    if (column.type === "text") {
      if (distinct.size < 10000) distinct.add(v);
    } else {
      if (min === null || v < min) min = v;
      if (max === null || v > max) max = v;
    }
  }
  const empty = rows.length - count;
  const emptyNote = empty ? `, ${empty} empty` : "";
  if (!count) return `${column.type}, always empty`;
  if (column.type === "number") return `number, min ${min}, max ${max}, mean ${Math.round((sum / count) * 100) / 100}${emptyNote}`;
  if (column.type === "date") return `date (ISO), from ${min} to ${max}${emptyNote}`;
  const examples = [...distinct].slice(0, 4).map((v) => JSON.stringify(clip(v, 40))).join(", ");
  const many = distinct.size >= 10000 ? "10000+" : distinct.size;
  return `text, ${many} distinct values (e.g. ${examples})${emptyNote}`;
}

function csvAttachment(name, text, size) {
  const delimiter = detectDelimiter(text);
  const table = parseCsv(text, delimiter);
  if (table.length < 2) throw new Error("CSV vide ou sans ligne de données");
  const names = uniqueNames(table[0]);
  const body = table.slice(1);
  const columns = names.map((n, ci) => ({ name: n, type: inferType(body, ci) }));
  const rows = new Array(body.length);
  for (let r = 0; r < body.length; r++) {
    const src = body[r];
    const row = {};
    for (let ci = 0; ci < columns.length; ci++) row[columns[ci].name] = convert(src[ci], columns[ci].type);
    rows[r] = row;
  }

  const summary = fit([
    `CSV file ${JSON.stringify(name)}: ${rows.length} rows, ${columns.length} columns, delimiter ${JSON.stringify(delimiter)}.`,
    "Columns (PRISM_FILE.columns):",
    ...columns.map((c) => `- ${JSON.stringify(c.name)}: ${describeColumn(c, rows)}`),
    "First rows, exactly as in PRISM_FILE.rows:",
    ...rows.slice(0, 5).map((r) => clip(JSON.stringify(r), 400)),
  ]);
  return {
    name,
    kind: "csv",
    size,
    meta: `CSV · ${nf.format(rows.length)} lignes × ${columns.length} colonnes · ${formatBytes(size)}`,
    summary,
    data: { name, kind: "csv", columns, rows, rowCount: rows.length },
  };
}

// --------------------------------------------------------------------------
// JSON
// --------------------------------------------------------------------------
function typeOf(v) {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

function shape(value, depth = 0) {
  const t = typeOf(value);
  if (t === "array") return value.length ? `array[${value.length}] of ${shape(value[0], depth + 1)}` : "array[0]";
  if (t !== "object") return t;
  if (depth > 3) return "{…}";
  const keys = Object.keys(value);
  const inner = keys.slice(0, 20).map((k) => `${JSON.stringify(k)}: ${shape(value[k], depth + 1)}`);
  if (keys.length > 20) inner.push(`… +${keys.length - 20} keys`);
  return `{ ${inner.join(", ")} }`;
}

function sampleOf(value, depth = 0) {
  const t = typeOf(value);
  if (t === "string") return clip(value, 60);
  if (t === "array") return depth > 4 ? "…" : value.slice(0, 2).map((v) => sampleOf(v, depth + 1));
  if (t !== "object") return value;
  if (depth > 4) return "…";
  return Object.fromEntries(Object.keys(value).slice(0, 12).map((k) => [k, sampleOf(value[k], depth + 1)]));
}

function describeRoot(data) {
  const t = typeOf(data);
  if (t === "array") return `array of ${data.length} ${data.length ? typeOf(data[0]) : ""} items`.trim();
  if (t === "object") return `object with ${Object.keys(data).length} keys`;
  return t;
}

function jsonAttachment(name, text, size) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON invalide : ${err.message}`);
  }
  const summary = fit([
    `JSON file ${JSON.stringify(name)} (${formatBytes(size)}). Root: ${describeRoot(data)}. PRISM_FILE.data is the parsed value.`,
    "Structure (arrays show their length and the shape of their first item):",
    clip(shape(data), 1600),
    "Sample (arrays cut to 2 items, strings to 60 chars):",
    clip(JSON.stringify(sampleOf(data)), 1600),
  ]);
  const root = typeOf(data);
  const count = root === "array" ? `${nf.format(data.length)} éléments` : root === "object" ? `${Object.keys(data).length} clés` : root;
  return { name, kind: "json", size, meta: `JSON · ${count} · ${formatBytes(size)}`, summary, data: { name, kind: "json", data } };
}

// --------------------------------------------------------------------------
// TXT
// --------------------------------------------------------------------------
function txtAttachment(name, text, size) {
  const lineCount = text.split(/\r?\n/).length;
  const wordCount = (text.match(/\S+/g) || []).length;
  const summary = fit([
    `Text file ${JSON.stringify(name)}: ${lineCount} lines, ${wordCount} words, ${text.length} characters. PRISM_FILE.text holds all of it.`,
    "Beginning:",
    clip(text, 2600),
  ]);
  return {
    name,
    kind: "txt",
    size,
    meta: `Texte · ${nf.format(lineCount)} lignes · ${nf.format(wordCount)} mots · ${formatBytes(size)}`,
    summary,
    data: { name, kind: "txt", text, lineCount, wordCount },
  };
}

/** Fichier d'exemple pour essayer l'import sans avoir de CSV sous la main. */
export function sampleCsvAttachment() {
  const regions = ["Nord", "Sud", "Est", "Ouest"];
  const lines = ["mois;region;ventes;clients"];
  for (let m = 1; m <= 12; m++) {
    regions.forEach((region, r) => {
      const ventes = Math.round(9000 + 2600 * Math.sin((m + r * 2) / 2) + m * 420 + r * 900);
      const clients = Math.round(ventes / (38 + r * 3));
      lines.push(`2025-${String(m).padStart(2, "0")};${region};${ventes};${clients}`);
    });
  }
  return parseAttachment("ventes-2025.csv", "csv", lines.join("\n"));
}
