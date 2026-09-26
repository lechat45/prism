// Engramme cognitif (V4) côté page : document des cartes, données relues, trait « ADN ».
//
// Une carte Engramme est un widget comme les autres (iframe sandbox, Mon Hub, export .html…) dont le
// document est assemblé ici : gabarit engine/engram/viewer.html + moteur physique + données. Les données
// restent inscrites dans le document (JSON inerte) : la page les relit sans rien exécuter, y compris
// pour une carte revenue de « Mon Hub » sur un autre appareil.

const E = window.PrismEngram;
const cache = new Map(); // chemin -> Promise<texte>
const parsed = new WeakMap(); // carte -> { html, engram }

function text(path) {
  if (!cache.has(path)) {
    const pending = fetch(`engine/engram/${path}`)
      .then((res) => {
        if (!res.ok) throw new Error(`${path} introuvable (HTTP ${res.status})`);
        return res.text();
      })
      .catch((err) => {
        cache.delete(path);
        throw err;
      });
    cache.set(path, pending);
  }
  return cache.get(path);
}

/** Document autonome d'une carte Engramme. */
export async function engramHtml(engram, libs) {
  const [template, physics] = await Promise.all([text("viewer.html"), text("physics.js")]);
  return E.buildViewer(template, physics, engram, libs, "fr");
}

/** Données de l'Engramme d'une carte (null pour un widget ordinaire), relues une fois par version du code. */
export function engramOf(card) {
  if (!card?.html) return null;
  const hit = parsed.get(card);
  if (hit && hit.html === card.html) return hit.engram;
  const engram = E.readViewer(card.html);
  parsed.set(card, { html: card.html, engram });
  return engram;
}

export const isEngram = (card) => Boolean(engramOf(card));

/** Trait d'un nœud, prêt pour la génération (« Injection d'ADN »), ou null. */
export const dnaFrom = (card, nodeId) => E.dnaOf(engramOf(card), nodeId);

/** « Engramme : Marie Curie », « engramme de Marie Curie » → « Marie Curie » (sinon null). */
export const engramRequest = (text) => E.engramRequest(text);

export const CATEGORY_LABELS = { core: "Noyau", engine: "Moteur", shadow: "Ombre", artifact: "Artefact" };
