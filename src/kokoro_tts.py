import sys
import soundfile as sf
from kokoro_onnx import Kokoro

text_path, output_path, model_path, voices_path = sys.argv[1:5]
with open(text_path, "r", encoding="utf-8") as f:
    text = f.read().strip()
if not text:
    raise SystemExit("No narration text was supplied for Kokoro TTS")
kokoro = Kokoro(model_path, voices_path)
samples, sample_rate = kokoro.create(text, voice="af_sarah", speed=1.0, lang="en-us")
sf.write(output_path, samples, sample_rate)
print(f"Kokoro voiceover created: {output_path} ({sample_rate} Hz)")
