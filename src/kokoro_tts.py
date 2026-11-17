import re
import sys
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

text_path, output_path, model_path, voices_path = sys.argv[1:5]
with open(text_path, "r", encoding="utf-8") as f:
    text = re.sub(r"\s+", " ", f.read()).strip()
if not text:
    raise SystemExit("No narration text was supplied for Kokoro TTS")

# Split long scripts into short sentence groups to stay within Kokoro's input limit.
sentences = re.split(r"(?<=[.!?])\s+", text)
chunks, current = [], ""
for sentence in sentences:
    if current and len(current) + len(sentence) + 1 > 320:
        chunks.append(current)
        current = sentence
    else:
        current = (current + " " + sentence).strip()
if current:
    chunks.append(current)

kokoro = Kokoro(model_path, voices_path)
try:
    pieces = []
    sample_rate = None
    for chunk in chunks:
        samples, sample_rate = kokoro.create(
            chunk, voice="af_sarah", speed=1.0, lang="en-us"
        )
        pieces.append(np.asarray(samples, dtype=np.float32))
        # Short pause between sentence groups.
        pieces.append(np.zeros(int(sample_rate * 0.18), dtype=np.float32))
    audio = np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.float32)
    sf.write(output_path, audio, sample_rate, subtype="PCM_16")
    print(f"Kokoro voiceover created: {output_path} ({sample_rate} Hz, {len(chunks)} chunks)")
finally:
    voices = getattr(kokoro, "voices", None)
    close = getattr(voices, "close", None)
    if callable(close):
        close()
