"""Print a non-reversible fingerprint of the ChatGPT account in ~/.codex/auth.json.

Reads the id_token's payload claims (email, chatgpt_account_id) — never the tokens themselves —
and prints sha256 fingerprints, so two containers can be compared without revealing either.
With --raw-email the email is printed (for the observation record kept inside the stack).
"""
import base64, hashlib, json, os, sys

a = json.load(open(os.path.expanduser("~/.codex/auth.json")))
tok = (a.get("tokens") or {}).get("id_token") or ""
part = tok.split(".")[1] if tok.count(".") >= 2 else ""
claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))) if part else {}
auth = claims.get("https://api.openai.com/auth") or {}
email = claims.get("email") or ""
acct = auth.get("chatgpt_account_id") or (a.get("tokens") or {}).get("account_id") or ""
fp = lambda s: hashlib.sha256(s.encode()).hexdigest()[:16] if s else None
out = {"email_fp": fp(email.lower()), "account_fp": fp(acct), "plan": auth.get("chatgpt_plan_type")}
if "--raw-email" in sys.argv:
    out["email"] = email
print(json.dumps(out))
