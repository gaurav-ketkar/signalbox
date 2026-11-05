# Writes the demo narration with Kokoro (local TTS). Usage:
#   uv run --with kokoro --with soundfile python scripts/demo-voice.py OUT_DIR
# Then: node scripts/record-demo.cjs OUT_DIR
import json, sys
from pathlib import Path
import numpy as np, soundfile as sf
from kokoro import KPipeline

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
lines = json.loads((Path(__file__).parent / "demo-narration.json").read_text())
pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
lengths = []
for i, text in enumerate(lines):
    audio = np.concatenate([np.asarray(a) for _, _, a in pipe(text, voice="af_heart", speed=1.08)])
    sf.write(out / f"vo-{i}.wav", audio, 24000)
    lengths.append(round(len(audio) / 24000, 3))
(out / "durations.json").write_text(json.dumps(lengths))
print(lengths)
