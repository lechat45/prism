// Tests de l'import de fichiers (js/files.js).  Lancement : node --test "frontend/tests/*.test.*"
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectDelimiter, forRequest, kindOf, parseAttachment, parseCsv, parseDate, parseNumber, sampleCsvAttachment,
} from "../js/files.js";

test("type de fichier par extension ou type MIME", () => {
  assert.equal(kindOf({ name: "ventes.CSV", type: "" }), "csv");
  assert.equal(kindOf({ name: "export.tsv", type: "" }), "csv");
  assert.equal(kindOf({ name: "data", type: "application/json" }), "json");
  assert.equal(kindOf({ name: "notes.md", type: "" }), "txt");
  assert.equal(kindOf({ name: "photo.png", type: "image/png" }), null);
});

test("CSV : séparateur détecté, guillemets et retours à la ligne dans les champs", () => {
  assert.equal(detectDelimiter("a;b;c\n1;2;3\n4;5;6"), ";");
  assert.equal(detectDelimiter("a\tb\n1\t2"), "\t");
  assert.equal(detectDelimiter('nom,ville\n"Dupont, Jean",Paris'), ",");
  const rows = parseCsv('nom,note\r\n"Dupont, ""JD""",12\n"multi\nligne",3\n', ",");
  assert.deepEqual(rows, [["nom", "note"], ['Dupont, "JD"', "12"], ["multi\nligne", "3"]]);
});

test("nombres et dates au format français", () => {
  assert.equal(parseNumber("1 234,5"), 1234.5);
  assert.equal(parseNumber("1.234,5"), 1234.5);
  assert.equal(parseNumber("1,234.5"), 1234.5);
  assert.equal(parseNumber("12,5 €"), 12.5);
  assert.equal(parseNumber("-3e2"), -300);
  assert.equal(parseNumber("12 ans"), null);
  assert.equal(parseDate("24/09/2026"), "2026-09-24");
  assert.equal(parseDate("09/24/2026"), "2026-09-24"); // mois > 12 impossible : format US
  assert.equal(parseDate("2026-09"), "2026-09");
  assert.equal(parseDate("31/31/2026"), null);
});

test("CSV → PRISM_FILE typé + résumé pour le LLM", () => {
  const att = parseAttachment("v.csv", "csv", "mois;région;total;commentaire\n01/01/2025;Nord;1 200,5;ok\n01/02/2025;Sud;;\n");
  assert.equal(att.kind, "csv");
  assert.deepEqual(att.data.columns, [
    { name: "mois", type: "date" }, { name: "région", type: "text" }, { name: "total", type: "number" }, { name: "commentaire", type: "text" },
  ]);
  assert.deepEqual(att.data.rows[0], { mois: "2025-01-01", région: "Nord", total: 1200.5, commentaire: "ok" });
  assert.equal(att.data.rows[1].total, null);
  assert.equal(att.data.rowCount, 2);
  assert.match(att.summary, /2 rows, 4 columns/);
  assert.match(att.summary, /"total": number, min 1200\.5, max 1200\.5/);
  assert.match(att.meta, /2 lignes × 4 colonnes/);
  assert.deepEqual(Object.keys(forRequest(att)), ["name", "kind", "summary"], "les données complètes ne partent jamais au LLM");
});

test("colonnes sans nom ou en double", () => {
  const att = parseAttachment("x.csv", "csv", "a,,a\n1,2,3");
  assert.deepEqual(att.data.columns.map((c) => c.name), ["a", "colonne 2", "a (2)"]);
});

test("JSON : structure décrite, erreur lisible si invalide", () => {
  const att = parseAttachment("u.json", "json", JSON.stringify({ users: [{ id: 1, tags: ["a"] }, { id: 2, tags: [] }], ok: true }));
  assert.match(att.summary, /object with 2 keys/);
  assert.match(att.summary, /"users": array\[2\] of \{ "id": number, "tags": array\[1\] of string \}/);
  assert.deepEqual(att.data.data.ok, true);
  assert.throws(() => parseAttachment("bad.json", "json", "{oups"), /JSON invalide/);
});

test("TXT : statistiques et début du texte", () => {
  const att = parseAttachment("n.txt", "txt", "Bonjour le monde\nsecond ligne");
  assert.deepEqual([att.data.lineCount, att.data.wordCount], [2, 5]);
  assert.match(att.summary, /Beginning:\nBonjour le monde/);
});

test("résumé plafonné pour rester dans le quota de tokens", () => {
  const big = ["id,texte", ...Array.from({ length: 5000 }, (_, i) => `${i},${"x".repeat(300)}`)].join("\n");
  const att = parseAttachment("big.csv", "csv", big);
  assert.ok(att.summary.length <= 3900, `résumé de ${att.summary.length} caractères`);
  assert.equal(att.data.rowCount, 5000);
});

test("fichier d'exemple CSV", () => {
  const att = sampleCsvAttachment();
  assert.equal(att.data.rowCount, 48);
  assert.deepEqual(att.data.columns.map((c) => c.type), ["date", "text", "number", "number"]);
});
