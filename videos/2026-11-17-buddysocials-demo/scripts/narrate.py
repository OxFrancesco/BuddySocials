# Generates each narration line once (skips lines that already exist). Key comes from the
# environment (ELEVEN_KEY) for this one command and is never written anywhere.
import json, os, sys, base64, urllib.request
here = os.path.dirname(os.path.abspath(__file__))
cfg = json.load(open(os.path.join(here, "narration.json")))
out = os.path.join(here, "..", "public", "voice")
key = os.environ["ELEVEN_KEY"]
lines = cfg["lines"]
for i, line in enumerate(lines):
    mp3 = os.path.join(out, line["id"] + ".mp3")
    if os.path.exists(mp3):
        print("skip", line["id"]); continue
    body = {
        "text": line["text"], "model_id": cfg["model"], "voice_settings": cfg["settings"],
        "previous_text": lines[i - 1]["text"] if i else None,
        "next_text": lines[i + 1]["text"] if i + 1 < len(lines) else None,
    }
    body = {k: v for k, v in body.items() if v is not None}
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{cfg['voiceId']}/with-timestamps?output_format=mp3_44100_192",
        data=json.dumps(body).encode(), headers={"xi-api-key": key, "Content-Type": "application/json"})
    try:
        res = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        print("FAILED", line["id"], e.code, e.read()[:300]); sys.exit(1)
    cost = res.headers.get("character-cost")
    data = json.load(res)
    open(mp3, "wb").write(base64.b64decode(data["audio_base64"]))
    json.dump(data.get("alignment"), open(os.path.join(out, line["id"] + ".json"), "w"))
    print("ok", line["id"], "chars", len(line["text"]), "cost-header", cost)
