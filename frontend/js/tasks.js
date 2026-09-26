// Traitements lourds de Prism, exécutés dans le Web Worker (worker.js) — ou, si le navigateur
// refuse le worker (page ouverte en file://), sur le fil principal via offload.js.
//  - attach   : lecture + analyse d'un fichier joint (jusqu'à 5 Mo de CSV) ;
//  - sample   : fichier CSV d'exemple ;
//  - generate : moteur navigateur (appel Gemini, nettoyage et validation du code reçu, ou démo) ;
//  - engram   : Engramme cognitif (appel Gemini en JSON imposé et validation, ou démo).

import { readAttachment, sampleCsvAttachment } from "./files.js";

/** Pièce jointe prête à l'emploi : les données (PRISM_FILE) deviennent un Blob JSON.
 *  Un Blob circule par simple poignée (worker → page → IndexedDB → iframe) : le fil principal
 *  ne copie, ne clone ni ne sérialise jamais les mégaoctets de données. */
export function pack(attachment) {
  const { data, ...rest } = attachment;
  return { ...rest, blob: new Blob([JSON.stringify(data)], { type: "application/json" }) };
}

let localEngine = null;
function engine() {
  // engine/sanitize.js et engine/local.js (scripts classiques) définissent globalThis.PrismLocal.
  if (!localEngine) {
    localEngine = globalThis.PrismLocal.createLocalEngine({ baseUrl: new URL("../engine/", import.meta.url).href });
  }
  return localEngine;
}

export const tasks = {
  attach: async ({ file }) => pack(await readAttachment(file)),
  sample: async () => pack(sampleCsvAttachment()),
  generate: ({ prompt, options }, signal) => engine().generate(prompt, { ...options, signal }),
  engram: ({ person, options }, signal) => engine().engram(person, { ...options, signal }),
  engramChat: ({ engram, history, message, options }, signal) => engine().engramChat(engram, history, message, { ...options, signal }),
};
