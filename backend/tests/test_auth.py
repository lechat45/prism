"""Comptes : inscription, connexion, jetons, protections."""
from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta

import jwt
from fastapi.testclient import TestClient
from helpers import PASSWORD, DbTestCase

import app as prism
import db
import security
from models import User


class AuthTests(DbTestCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(prism.app)

    def test_register_grants_50_sparks_and_normalizes_email(self):
        res = self.client.post("/api/auth/register", json={"email": "  Alice@Exemple.FR ", "password": PASSWORD})
        self.assertEqual(res.status_code, 201)
        body = res.json()
        self.assertEqual(body["user"]["email"], "alice@exemple.fr")
        self.assertEqual(body["user"]["sparks"], 50)
        self.assertEqual(body["token_type"], "bearer")
        me = self.client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
        self.assertEqual(me.json()["email"], "alice@exemple.fr")

    def test_password_is_hashed_with_scrypt(self):
        self.register(self.client)
        with db.session() as s:
            stored = s.query(User).one().password_hash
        self.assertTrue(stored.startswith("scrypt$"))
        self.assertNotIn(PASSWORD, stored)
        self.assertTrue(security.verify_password(PASSWORD, stored))
        self.assertFalse(security.verify_password(PASSWORD + "!", stored))
        self.assertFalse(security.verify_password(PASSWORD, "n'importe quoi"))
        # Deux comptes avec le même mot de passe n'ont pas la même empreinte (sel aléatoire).
        self.assertNotEqual(security.hash_password(PASSWORD), security.hash_password(PASSWORD))

    def test_duplicate_email_is_refused(self):
        self.register(self.client)
        res = self.client.post("/api/auth/register", json={"email": "ALICE@exemple.fr", "password": PASSWORD})
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()["detail"]["code"], "email_taken")

    def test_invalid_input_is_refused(self):
        for body in ({"email": "pas-un-email", "password": PASSWORD}, {"email": "a@b.fr", "password": "court"},
                     {"email": "a@b.fr", "password": "x" * 129}, {"email": "a@b.fr"}):
            with self.subTest(body=body):
                self.assertEqual(self.client.post("/api/auth/register", json=body).status_code, 422)

    def test_login(self):
        self.register(self.client)
        ok = self.client.post("/api/auth/login", json={"email": "Alice@exemple.fr", "password": PASSWORD})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()["user"]["sparks"], 50)
        for body in ({"email": "alice@exemple.fr", "password": PASSWORD + "x"},
                     {"email": "inconnu@exemple.fr", "password": PASSWORD}):
            with self.subTest(body=body):
                res = self.client.post("/api/auth/login", json=body)
                self.assertEqual(res.status_code, 401)
                # Même réponse pour un mauvais mot de passe et un compte inexistant.
                self.assertEqual(res.json()["detail"]["code"], "bad_credentials")

    def test_login_brute_force_is_throttled(self):
        self.register(self.client)
        wrong = {"email": "alice@exemple.fr", "password": "mauvais-mot-de-passe"}
        codes = [self.client.post("/api/auth/login", json=wrong).status_code for _ in range(11)]
        self.assertEqual(codes[:10], [401] * 10)
        self.assertEqual(codes[10], 429)
        # Même le bon mot de passe attend la fin de la fenêtre.
        self.assertEqual(self.client.post("/api/auth/login", json={**wrong, "password": PASSWORD}).status_code, 429)

    def test_guest_account_works_like_a_real_one(self):
        res = self.client.post("/api/auth/guest")
        self.assertEqual(res.status_code, 201, res.text)
        session = res.json()
        self.assertTrue(session["user"]["guest"])
        self.assertTrue(session["user"]["email"].endswith("@essai.prism.invalid"))
        self.assertEqual(session["user"]["sparks"], 10)
        me = self.client.get("/api/auth/me", headers={"Authorization": f"Bearer {session['token']}"}).json()
        self.assertEqual((me["guest"], me["sparks"]), (True, 10))
        other = self.client.post("/api/auth/guest").json()
        self.assertNotEqual(other["user"]["email"], session["user"]["email"], "un compte d'essai par clic")
        # Adresse réservée : impossible de s'inscrire avec, impossible de s'y reconnecter (mot de passe inconnu).
        taken = self.client.post("/api/auth/register", json={"email": "essai-1@essai.prism.invalid", "password": PASSWORD})
        self.assertEqual(taken.status_code, 422)
        login = self.client.post("/api/auth/login", json={"email": session["user"]["email"], "password": PASSWORD})
        self.assertEqual(login.status_code, 401)
        self.assertEqual(self.client.get("/api/health").json()["guest_sparks"], 10)

    def test_guest_accounts_share_the_registration_limit(self):
        codes = [self.client.post("/api/auth/guest").status_code for _ in range(11)]
        self.assertEqual(codes[:10], [201] * 10)
        self.assertEqual(codes[10], 429)

    def test_registration_is_throttled_per_ip(self):
        codes = [self.client.post("/api/auth/register", json={"email": f"u{i}@exemple.fr", "password": PASSWORD}).status_code
                 for i in range(11)]
        self.assertEqual(codes[:10], [201] * 10)
        self.assertEqual(codes[10], 429)

    def test_protected_routes_require_a_valid_token(self):
        headers = self.register(self.client)
        token = headers["Authorization"].split()[1]
        user_id = security.decode_token(token)["sub"]
        now = datetime.now(UTC)
        forged = {
            "absent": {},
            "mauvais schéma": {"Authorization": f"Basic {token}"},
            "falsifié": {"Authorization": f"Bearer {token[:-4]}AAAA"},
            "autre secret": {"Authorization": "Bearer " + jwt.encode(
                {"sub": str(user_id), "ver": 0, "iss": "prism", "iat": now, "exp": now + timedelta(hours=1)},
                "un-autre-secret-suffisamment-long-pour-hs256", algorithm="HS256")},
            "expiré": {"Authorization": "Bearer " + security.create_token(user_id, 0, now=now - timedelta(days=30))},
            "alg none": {"Authorization": "Bearer " + jwt.encode(
                {"sub": str(user_id), "ver": 0, "iss": "prism", "iat": now, "exp": now + timedelta(hours=1)},
                None, algorithm="none")},
        }
        for label, h in forged.items():
            for method, path in (("get", "/api/auth/me"), ("post", "/api/generate"), ("get", "/api/widgets"), ("get", "/api/sparks")):
                with self.subTest(jeton=label, route=path):
                    extra = {"json": {"prompt": "x"}} if method == "post" else {}
                    res = getattr(self.client, method)(path, headers=h, **extra)
                    self.assertEqual(res.status_code, 401)
                    self.assertEqual(res.headers.get("www-authenticate"), "Bearer")
        self.assertEqual(self.client.get("/api/auth/me", headers=headers).status_code, 200)

    def test_revoked_sessions(self):
        headers = self.register(self.client)
        with db.session() as s, s.begin():
            s.query(User).one().token_version += 1  # ex. changement de mot de passe
        self.assertEqual(self.client.get("/api/auth/me", headers=headers).status_code, 401)

    def test_health_announces_auth_and_pricing(self):
        health = self.client.get("/api/health").json()
        self.assertTrue(health["auth"])
        self.assertEqual(health["pricing"], {"generate": 1, "refactor": 0.5, "engram": 2, "engram_chat": 0.25, "engram_fusion": 3,
                                             "nexus_think": 0.25, "nexus_debate": 1,
                                             "nexus_think_deep": 0.5, "nexus_think_council": 1,
                                             "nexus_debate_deep": 2, "nexus_debate_council": 3})
        self.assertEqual(health["signup_sparks"], 50)


if __name__ == "__main__":
    unittest.main()
