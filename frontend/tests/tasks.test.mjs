// Tests des traitements du Web Worker (js/tasks.js).  Lancement : node --test "frontend/tests/*.test.*"
import test from "node:test";
import assert from "node:assert/strict";
import { parseAttachment } from "../js/files.js";
import { pack, tasks } from "../js/tasks.js";

const CSV = "mois;ventes\n2025-01;12,5\n2025-02;</script>\n";

test("pièce jointe emballée : Blob JSON à la place des objets, métadonnées intactes", async () => {
  const att = parseAttachment("v.csv", "csv", CSV);
  const packed = pack(att);
  assert.ok(!("data" in packed), "aucun graphe d'objets ne remonte au fil principal");
  assert.ok(packed.blob instanceof Blob);
  assert.equal(packed.blob.type, "application/json");
  assert.deepEqual(JSON.parse(await packed.blob.text()), att.data);
  for (const key of ["name", "kind", "size", "meta", "summary"]) assert.equal(packed[key], att[key], key);
});

test("tâche attach : lecture d'un File, erreurs lisibles", async () => {
  const packed = await tasks.attach({ file: new File([CSV], "ventes.csv", { type: "text/csv" }) });
  assert.equal(packed.kind, "csv");
  assert.match(packed.meta, /2 lignes × 2 colonnes/);
  assert.equal(JSON.parse(await packed.blob.text()).rows[1].ventes, "</script>");
  await assert.rejects(tasks.attach({ file: new File(["x"], "photo.png", { type: "image/png" }) }), /format non pris en charge/);
});

test("tâche sample : fichier d'exemple emballé", async () => {
  const packed = await tasks.sample();
  assert.equal(packed.name, "ventes-2025.csv");
  assert.equal(JSON.parse(await packed.blob.text()).rowCount, 48);
});
