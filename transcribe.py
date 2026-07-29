#!/usr/bin/env python3
"""CPU transcription helper used by the GitHub Actions worker."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from faster_whisper import WhisperModel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe an audio file with faster-whisper")
    parser.add_argument("--input", required=True, type=Path, help="Input audio file")
    parser.add_argument("--output", required=True, type=Path, help="UTF-8 transcript output")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.input.is_file():
        raise FileNotFoundError(f"Audio file not found: {args.input}")

    model_name = os.getenv("WHISPER_MODEL", "large-v3")
    compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
    language = os.getenv("WHISPER_LANGUAGE", "es")
    initial_prompt = os.getenv("WHISPER_INITIAL_PROMPT", "").strip() or None
    cpu_threads = max(1, int(os.getenv("WHISPER_CPU_THREADS", str(os.cpu_count() or 2))))

    print(
        f"[WHISPER] Loading model={model_name} device=cpu "
        f"compute_type={compute_type} threads={cpu_threads}",
        flush=True,
    )

    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type=compute_type,
        cpu_threads=cpu_threads,
    )

    segments, info = model.transcribe(
        str(args.input),
        language=language,
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        initial_prompt=initial_prompt,
        condition_on_previous_text=True,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = args.output.with_suffix(args.output.suffix + ".tmp")
    written_segments = 0

    with temporary_output.open("w", encoding="utf-8", newline="\n") as output_file:
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            output_file.write(text)
            output_file.write("\n")
            written_segments += 1
            if written_segments % 100 == 0:
                print(
                    f"[WHISPER] Processed {written_segments} segments "
                    f"through {segment.end / 60:.1f} minutes",
                    flush=True,
                )

    if written_segments == 0:
        temporary_output.unlink(missing_ok=True)
        raise RuntimeError("Whisper produced no transcript segments")

    temporary_output.replace(args.output)
    print(
        f"[WHISPER] Complete: language={info.language} "
        f"probability={info.language_probability:.3f} segments={written_segments}",
        flush=True,
    )


if __name__ == "__main__":
    main()
