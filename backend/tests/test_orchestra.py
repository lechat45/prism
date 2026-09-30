"""V6.3, orchestre de modèles : chaînes par tâche, quotas par couple clé × modèle, modes Profond et Conseil du Nexus."""
from __future__ import annotations

import asyncio
import json
import re
import time

import httpx
from fastapi.testclient import TestClient
from helpers import DbTestCase

import app as prism
import providers
from test_nexus import BRIEF, CURIE, JOBS, THOUGHT

KEYS = "cle-alpha,cle-beta,cle-gamma"
PRO = ("gemini-3.1-pro-preview", "gemini-pro-latest")
ZERO_QUOTA = {"error": {"code": 429, "message": "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro"}}


class OrchestraTests(DbTestCase):
    def setUp(self):
        super().setUp()
        self._saved = (prism.GEMINI_API_KEY, prism.GEMINI_MODELS, prism._http_client)
        prism.GEMINI_API_KEY = KEYS
        prism.GEMINI_MODELS = list(prism.GEMINI_DEFAULT_MODELS)  # l'orchestre tel que livré
        self.calls: list[dict] = []
        self.down: set[str] = set()  # modèles surchargés (503)
        self.refuse_thinking: set[str] = set()  # modèles qui refusent un niveau de réflexion
        self.slow: set[str] = set()  # modèles qui ne répondent pas dans le délai
        self.tardy: set[str] = set()  # modèles qui répondent, mais au bout de 3 secondes

        def handler(request: httpx.Request) -> httpx.Response:
            model = request.url.path.split("/models/")[1].split(":")[0]
            body = json.loads(request.content)
            system = body["systemInstruction"]["parts"][0]["text"]
            user = body["contents"][0]["parts"][0]["text"]
            self.calls.append({"model": model, "key": request.headers["x-goog-api-key"], "system": system, "user": user,
                               "config": body["generationConfig"]})
            if model in PRO:
                return httpx.Response(429, json=ZERO_QUOTA)
            if model in self.slow:
                raise httpx.ReadTimeout("trop lent", request=request)
            if model in self.down:
                return httpx.Response(503, json={"error": {"message": "high demand"}})
            if model in self.refuse_thinking and "thinkingConfig" in body["generationConfig"]:
                return httpx.Response(400, json={"error": {"message": "Thinking level is not supported for this model."}})
            if "COUNCIL VOICE" in system:
                name = re.search(r"YOU ARE\nname: (.+)", user).group(1)
                answer = {"text": f"{name} parle ({model})."}
            elif "COUNCIL SYNTHESIS" in system:
                answer = {"summary": "Un écran simple, nourri de mesures.", "points": ["Marie Curie — la mesure", "Steve Jobs — l'écran"],
                          "first_step": "Poser trois capteurs."}
            elif "COUNCIL ARBITER" in system:
                answer = {**THOUGHT, "lines": ["L'arbitre tranche : mesurer d'abord.", "Puis un seul écran."]}
            else:
                answer = {**THOUGHT, "lines": [f"Pensée de {model}.", "Deuxième phrase."]}
            response = httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": json.dumps(answer)}]}, "finishReason": "STOP"}]})
            if model in self.tardy:
                async def late():
                    await asyncio.sleep(3)
                    return response
                return late()
            return response

        prism._http_client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.client = TestClient(prism.app)
        self.auth = self.register(self.client)

    def tearDown(self):
        prism.GEMINI_API_KEY, prism.GEMINI_MODELS, prism._http_client = self._saved
        super().tearDown()

    def sparks(self) -> float:
        return self.client.get("/api/auth/me", headers=self.auth).json()["sparks"]

    def think(self, depth: str):
        return self.client.post("/api/nexus/think", json={"mind": CURIE, "inputs": [BRIEF], "depth": depth}, headers=self.auth)

    # ------------------------------------------------------------------ chaînes et santé
    def test_each_task_has_its_chain_and_a_forced_list_wins(self):
        self.assertEqual(prism.gemini_chain("widget"), prism.GEMINI_DEFAULT_MODELS)
        engram = prism.gemini_chain("engram")
        self.assertEqual(tuple(engram[:2]), PRO, "les modèles Pro d'abord, quand la clé y a droit")
        self.assertIn("gemini-3.5-flash-lite", engram)
        self.assertNotIn("gemma-4-31b-it", engram, "pas de modèle lent pour un Engramme de 8 000 jetons")
        self.assertEqual(prism.gemini_chain("nexus")[-2:], ["gemma-4-31b-it", "gemma-4-26b-a4b-it"])
        voices = prism.council_voices()
        self.assertEqual(len({voice[0] for voice in voices}), 3, "trois modèles différents au Conseil")
        prism.GEMINI_MODELS = ["modele-impose"]
        self.assertEqual((prism.gemini_chain("engram"), prism.council_voices()), (["modele-impose"], [["modele-impose"]] * 3))

    def test_health_describes_the_orchestra_never_the_keys(self):
        orchestra = self.client.get("/api/health").json()["orchestra"]
        self.assertEqual(set(orchestra["roles"]), {"pro", "fast", "lite", "open"})
        self.assertGreaterEqual(orchestra["models"], 13)
        self.assertEqual(orchestra["capacity"], {"pairs": 3 * orchestra["models"], "paused": 0})
        self.assertNotIn("cle-", json.dumps(orchestra))

    # ------------------------------------------------------------------ quotas par couple clé × modèle
    def test_pauses_target_a_key_and_model_pair(self):
        pool = providers.KeyPool(clock=lambda: 100.0)
        pool.pause("a", 429, "m1")
        self.assertEqual(pool.order(["a", "b"], "m1"), ["b", "a"])
        self.assertEqual(pool.order(["a", "b"], "m2")[0], "a", "la clé garde ses autres modèles")
        pool.pause("b", 429, "m2", long=True)
        self.assertEqual(pool.paused_until("b", "m2"), 100.0 + providers.KeyPool.LONG_PAUSE)
        pool.pause("a", 503)  # sans modèle : toute la clé
        self.assertEqual(pool.order(["a", "b"], "m3"), ["b", "a"])
        self.assertEqual(pool.stats(["a", "b"], ["m1", "m2", "m3"]), {"pairs": 6, "paused": 4})

    def test_zero_quota_rests_an_hour_and_is_then_skipped_without_a_call(self):
        res = self.client.post("/api/engram", json={"person": "Marie Curie"}, headers=self.auth)
        tried = [c["model"] for c in self.calls]
        self.assertEqual(tried[:6], [PRO[0]] * 3 + [PRO[1]] * 3, "chaque clé essaie les modèles Pro une fois")
        self.assertEqual(tried[6], "gemini-3.8-flash")
        pause = providers.KEYS.paused_until("cle-alpha", PRO[0]) - providers.KEYS.clock()
        self.assertGreater(pause, 3000, "quota nul : une heure de repos")
        self.calls.clear()
        self.think("deep")
        self.assertEqual(self.calls[0]["model"], "gemini-3.8-flash", "les modèles Pro sont sautés sans appel")
        self.assertIn(res.status_code, (200, 502))  # l'Engramme factice importe peu : seul le routage est vérifié ici

    def test_a_slow_model_rests_on_every_key_and_the_next_one_answers_at_once(self):
        self.slow.add("gemini-3.8-flash")
        res = self.think("fast")
        self.assertEqual((res.status_code, res.json()["model"]), (200, "gemini-3.7-flash"))
        self.calls.clear()
        self.think("fast")
        self.assertEqual(self.calls[0]["model"], "gemini-3.7-flash", "le modèle lent est sauté sur toutes les clés, sans appel")

    def test_a_tardy_model_is_overtaken_by_the_next_one(self):
        saved = prism.NEXUS_HEDGE_S
        prism.NEXUS_HEDGE_S = 0.2
        try:
            self.tardy.add("gemini-3.8-flash")
            t0 = time.perf_counter()
            res = self.think("fast")
            self.assertEqual((res.status_code, res.json()["model"]), (200, "gemini-3.7-flash"))
            self.assertLess(time.perf_counter() - t0, 2.5, "sans attendre la réponse du modèle en retard")
            self.assertEqual([c["model"] for c in self.calls], ["gemini-3.8-flash", "gemini-3.7-flash"])
            self.assertEqual(providers.KEYS.busy, {k: 0 for k in providers.KEYS.busy}, "l'appel dépassé est annulé")
        finally:
            prism.NEXUS_HEDGE_S = saved

    # ------------------------------------------------------------------ Profond
    def test_deep_thinks_harder_on_the_strongest_models(self):
        before = self.sparks()
        res = self.think("deep")
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual((body["depth"], body["cost"], body["model"]), ("deep", 0.5, "gemini-3.8-flash"))
        self.assertAlmostEqual(body["sparks"], before - 0.5)
        flash = [c for c in self.calls if c["model"] == "gemini-3.8-flash"][0]
        self.assertEqual(flash["config"]["thinkingConfig"], {"thinkingLevel": "high"})
        self.calls.clear()
        self.think("fast")
        self.assertNotIn("thinkingConfig", self.calls[0]["config"], "le mode rapide garde la réflexion par défaut")

    def test_a_refused_thinking_level_is_retried_without_it(self):
        self.refuse_thinking.add("gemini-3.8-flash")
        res = self.think("deep")
        self.assertEqual(res.status_code, 200, res.text)
        flash = [c for c in self.calls if c["model"] == "gemini-3.8-flash"]
        self.assertEqual(["thinkingConfig" in c["config"] for c in flash], [True, False])

    # ------------------------------------------------------------------ Conseil
    def test_every_council_voice_keeps_its_own_lite_model_when_google_saturates(self):
        voices = prism.council_voices()
        self.assertEqual(len({voice[-1] for voice in voices}), 3)
        self.assertTrue(all("lite" in voice[-1] for voice in voices))

    def test_council_hears_three_models_on_three_keys_then_arbitrates(self):
        before = self.sparks()
        res = self.think("council")
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual((body["depth"], body["cost"]), ("council", 1.0))
        self.assertAlmostEqual(body["sparks"], before - 1)
        self.assertEqual([v["model"] for v in body["council"]], ["gemini-3.8-flash", "gemini-3-flash-preview", "gemma-4-31b-it"])
        voices = [c for c in self.calls if "COUNCIL" not in c["system"]]
        self.assertEqual(len({c["key"] for c in voices}), 3, "chaque voix part sur une clé différente")
        judge = [c for c in self.calls if "COUNCIL ARBITER" in c["system"] and c["model"] not in PRO][0]
        self.assertIn("[3] by gemma-4-31b-it", judge["user"])
        self.assertEqual(judge["config"]["thinkingConfig"], {"thinkingLevel": "high"})
        self.assertEqual(body["thought"]["lines"][0], "L'arbitre tranche : mesurer d'abord.")

    def test_council_survives_silent_voices_and_refunds_when_all_are_silent(self):
        self.down |= {"gemini-3-flash-preview", "gemini-3.5-flash", "gemini-flash-latest", "gemini-flash-lite-latest", "gemma-4-31b-it",
                      "gemma-4-26b-a4b-it", "gemini-3.1-flash-lite"}
        body = self.think("council").json()
        self.assertEqual([v["model"] for v in body["council"]], ["gemini-3.8-flash"])
        self.assertEqual(body["thought"]["lines"][0], "Pensée de gemini-3.8-flash.", "une seule voix : pas d'arbitrage")
        self.down |= {m for voice in prism.council_voices() for m in voice}
        providers.KEYS.clear()
        before = self.sparks()
        res = self.think("council")
        self.assertEqual(res.status_code, 502)
        self.assertIn("aucune voix", res.text)
        self.assertAlmostEqual(self.sparks(), before)

    def test_council_war_room_gives_each_mind_its_own_model(self):
        before = self.sparks()
        res = self.client.post("/api/nexus/debate", json={"minds": [CURIE, JOBS], "question": "Comment le rendre lisible ?",
                                                          "context": BRIEF["text"], "depth": "council"}, headers=self.auth)
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual((body["depth"], body["cost"]), ("council", 3.0))
        self.assertAlmostEqual(body["sparks"], before - 3)
        self.assertEqual(body["council"], [{"author": "Marie Curie", "model": "gemini-3.8-flash"},
                                           {"author": "Steve Jobs", "model": "gemini-3-flash-preview"}])
        debate = body["debate"]
        self.assertEqual(debate["positions"][1]["text"], "Steve Jobs parle (gemini-3-flash-preview).")
        self.assertEqual([r["to"] for r in debate["replies"]], ["Steve Jobs", "Marie Curie"])
        replies = [c for c in self.calls if "COUNCIL VOICE" in c["system"] and "TASK: reply" in c["user"]]
        self.assertTrue(all("Marie Curie parle" in c["user"] for c in replies), "le second tour entend les positions")
        self.assertEqual(debate["synthesis"]["first_step"], "Poser trois capteurs.")

    def test_a_silent_voice_hands_the_floor_to_the_next_model(self):
        self.down |= {"gemini-3-flash-preview", "gemini-3.5-flash", "gemini-flash-latest", "gemini-flash-lite-latest"}
        res = self.client.post("/api/nexus/debate", json={"minds": [CURIE, JOBS], "question": "Comment ?", "depth": "council"},
                               headers=self.auth)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["council"][1], {"author": "Steve Jobs", "model": "gemma-4-31b-it"})

    def test_deep_debate_is_one_deeper_call(self):
        res = self.client.post("/api/nexus/debate", json={"minds": [CURIE, JOBS], "question": "Comment ?", "depth": "deep"},
                               headers=self.auth)
        # Le faux modèle répond par une pensée, pas un débat : refusé et remboursé, mais on vérifie le routage.
        self.assertEqual(res.status_code, 502)
        self.assertEqual(self.calls[0]["model"], PRO[0])
        self.assertTrue(all(c["config"].get("thinkingConfig") == {"thinkingLevel": "high"} for c in self.calls))
