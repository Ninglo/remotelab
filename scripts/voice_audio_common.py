#!/usr/bin/env python3

import contextlib
import io
import json
import math
import os
import platform
import re
import subprocess
import sys
import tempfile
import time
from collections import deque
from pathlib import Path

try:
    import mlx_whisper
except Exception:
    mlx_whisper = None

try:
    import numpy as np
except Exception:
    np = None

try:
    import sounddevice as sd
except Exception:
    sd = None

try:
    import soundfile as sf
except Exception:
    sf = None

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo-q4"


def trim(value):
    return str(value or "").strip()


def normalize_for_match(value):
    normalized = trim(value).lower()
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized


def is_compact_match_char(char):
    lowered = char.lower()
    return (
        ("a" <= lowered <= "z")
        or ("0" <= lowered <= "9")
        or ("\u4e00" <= char <= "\u9fff")
    )


def compact_for_match(value):
    return "".join(char.lower() for char in trim(value) if is_compact_match_char(char))


def compact_for_match_with_map(value):
    compact = []
    mapping = []
    original = str(value or "")
    for index, char in enumerate(original):
        if not is_compact_match_char(char):
            continue
        compact.append(char.lower())
        mapping.append(index)
    return "".join(compact), mapping


def default_wake_max_distance(wake_phrase):
    length = len(compact_for_match(wake_phrase))
    if length <= 4:
        return 1
    if length <= 8:
        return 2
    return 3


def levenshtein_distance(left, right, *, max_distance=None):
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for row_index, left_char in enumerate(left, start=1):
        current = [row_index]
        row_min = current[0]
        for col_index, right_char in enumerate(right, start=1):
            insertion = current[col_index - 1] + 1
            deletion = previous[col_index] + 1
            substitution = previous[col_index - 1] + (0 if left_char == right_char else 1)
            next_value = min(insertion, deletion, substitution)
            current.append(next_value)
            row_min = min(row_min, next_value)
        if max_distance is not None and row_min > max_distance:
            return max_distance + 1
        previous = current
    return previous[-1]


def find_wake_phrase_match(original_text, wake_phrase, *, prefix_only=False, max_distance=None, max_prefix_gap=2, window_extra=1):
    original = trim(original_text)
    phrase = trim(wake_phrase)
    if not original or not phrase:
        return None

    compact_original, mapping = compact_for_match_with_map(original)
    compact_phrase = compact_for_match(phrase)
    if not compact_original or not compact_phrase or not mapping:
        return None

    max_prefix_gap = max(0, int(max_prefix_gap))
    window_extra = max(0, int(window_extra))
    allowed_distance = default_wake_max_distance(phrase) if max_distance is None else max(0, int(max_distance))

    def build_match(start, end, distance, match_type):
        return {
            "distance": distance,
            "matchType": match_type,
            "normalizedStart": start,
            "normalizedEnd": end,
            "originalStart": mapping[start],
            "originalEnd": mapping[end - 1] + 1,
            "matchedText": original[mapping[start]:mapping[end - 1] + 1],
        }

    search_start = 0
    while True:
        index = compact_original.find(compact_phrase, search_start)
        if index < 0:
            break
        if not prefix_only or index <= max_prefix_gap:
            return build_match(index, index + len(compact_phrase), 0, "exact")
        search_start = index + 1

    if allowed_distance <= 0:
        return None

    if prefix_only:
        candidate_starts = range(0, min(len(compact_original), max_prefix_gap + 1))
    else:
        candidate_starts = range(len(compact_original))

    target_length = len(compact_phrase)
    best_match = None
    for start in candidate_starts:
        min_end = start + max(1, target_length - window_extra)
        max_end = min(len(compact_original), start + target_length + window_extra)
        for end in range(min_end, max_end + 1):
            candidate = compact_original[start:end]
            distance = levenshtein_distance(candidate, compact_phrase, max_distance=allowed_distance)
            if distance > allowed_distance:
                continue
            next_match = build_match(start, end, distance, "fuzzy")
            if best_match is None:
                best_match = next_match
                continue
            current_key = (next_match["distance"], next_match["normalizedStart"], abs((end - start) - target_length))
            best_key = (
                best_match["distance"],
                best_match["normalizedStart"],
                abs((best_match["normalizedEnd"] - best_match["normalizedStart"]) - target_length),
            )
            if current_key < best_key:
                best_match = next_match
    return best_match


def play_ack_sound(path):
    normalized = trim(path)
    if not normalized:
        return
    executable = "afplay" if platform.system() == "Darwin" else None
    if executable:
        try:
            subprocess.run([executable, normalized], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except Exception:
            pass
    try:
        sys.stdout.write("\a")
        sys.stdout.flush()
    except Exception:
        pass


def default_input_backend():
    if sd is not None and sf is not None:
        return "sounddevice"
    system = platform.system()
    if system == "Darwin":
        return "avfoundation"
    if system == "Linux":
        return "pulse"
    raise RuntimeError(f"Unsupported platform for microphone capture: {system}")


def default_input_source(backend):
    if backend == "sounddevice":
        if sd is not None:
            default_input = getattr(sd.default, "device", None)
            if isinstance(default_input, (list, tuple)) and len(default_input) >= 1 and default_input[0] is not None and default_input[0] >= 0:
                return str(default_input[0])
        return ""
    if backend == "avfoundation":
        return "0"
    if backend == "pulse":
        return "default"
    if backend == "alsa":
        return "default"
    raise RuntimeError(f"Unsupported input backend: {backend}")


def build_ffmpeg_input_args(backend, source):
    normalized_backend = trim(backend) or default_input_backend()
    normalized_source = trim(source) or default_input_source(normalized_backend)
    if normalized_backend == "avfoundation":
        spec = normalized_source if normalized_source.startswith(":") else f":{normalized_source}"
        return ["-f", "avfoundation", "-i", spec]
    if normalized_backend == "pulse":
        return ["-f", "pulse", "-i", normalized_source]
    if normalized_backend == "alsa":
        return ["-f", "alsa", "-i", normalized_source]
    raise RuntimeError(f"Unsupported input backend: {normalized_backend}")


def run_command(args, *, capture_output=False):
    kwargs = {
        "check": True,
        "text": True,
    }
    if capture_output:
        kwargs["stdout"] = subprocess.PIPE
        kwargs["stderr"] = subprocess.PIPE
    else:
        kwargs["stdout"] = subprocess.DEVNULL
        kwargs["stderr"] = subprocess.DEVNULL
    return subprocess.run(args, **kwargs)


def record_audio_sounddevice(output_path, *, duration_seconds, source=None):
    if sd is None or sf is None or np is None:
        raise RuntimeError("sounddevice backend requires sounddevice, soundfile, and numpy")
    output_path = str(Path(output_path).expanduser().resolve())
    normalized_source = trim(source)
    device = None
    if normalized_source:
        try:
            device = int(normalized_source)
        except ValueError:
            device = normalized_source
    sample_rate = 16000
    frames = max(1, int(round(float(duration_seconds) * sample_rate)))
    audio = sd.rec(
        frames,
        samplerate=sample_rate,
        channels=1,
        dtype="float32",
        device=device,
    )
    sd.wait()
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    sf.write(output_path, audio, sample_rate)
    if peak <= 1e-8:
        raise RuntimeError(
            "Microphone capture returned silence; on macOS this usually means the process is not running inside a microphone-authorized app context such as Terminal.app"
        )
    return output_path


def record_audio(output_path, *, duration_seconds, backend=None, source=None):
    output_path = str(Path(output_path).expanduser().resolve())
    backend = trim(backend) or default_input_backend()
    source = trim(source) or default_input_source(backend)
    if backend == "sounddevice":
        return record_audio_sounddevice(output_path, duration_seconds=duration_seconds, source=source)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        *build_ffmpeg_input_args(backend, source),
        "-t",
        str(duration_seconds),
        "-ac",
        "1",
        "-ar",
        "16000",
        output_path,
    ]
    run_command(cmd, capture_output=False)
    return output_path


def resolve_sounddevice_device(source=None):
    normalized_source = trim(source)
    if not normalized_source:
        normalized_source = trim(default_input_source("sounddevice"))
    if not normalized_source:
        return None
    try:
        return int(normalized_source)
    except ValueError:
        return normalized_source


def chunk_level(chunk):
    if np is None or chunk is None or not getattr(chunk, "size", 0):
        return 0.0
    samples = chunk.astype(np.float64, copy=False)
    return float(np.sqrt(np.mean(samples * samples)))


def capture_until_silence(
    output_path=None,
    *,
    timeout_ms=15000,
    speech_start_timeout_ms=5000,
    silence_ms=900,
    frame_ms=100,
    pre_roll_ms=250,
    speech_threshold=0.0015,
    sample_rate=16000,
    backend="sounddevice",
    source="",
):
    normalized_backend = trim(backend) or default_input_backend()
    if normalized_backend != "sounddevice":
        raise RuntimeError("capture_until_silence currently supports only the sounddevice backend")
    if sd is None or sf is None or np is None:
        raise RuntimeError("sounddevice, soundfile, and numpy are required")

    resolved_output_path = str(Path(trim(output_path) or make_temp_wav("voice-capture-")).expanduser().resolve())
    device = resolve_sounddevice_device(source)
    frame_ms = max(20, int(frame_ms))
    frame_count = max(1, int(round(sample_rate * frame_ms / 1000)))
    pre_roll_blocks = max(1, int(math.ceil(max(0, pre_roll_ms) / frame_ms)))
    silence_blocks_needed = max(1, int(math.ceil(max(1, silence_ms) / frame_ms)))
    speech_deadline = time.monotonic() + max(1, speech_start_timeout_ms) / 1000.0
    hard_deadline = time.monotonic() + max(1, timeout_ms) / 1000.0

    pre_roll = deque(maxlen=pre_roll_blocks)
    frames = []
    started = False
    silent_blocks = 0
    peak_seen = 0.0
    ambient_levels = deque(maxlen=max(3, int(math.ceil(max(300, pre_roll_ms) / frame_ms))))
    active_threshold = max(float(speech_threshold), 1e-6)
    trailing_keep_blocks = max(1, int(math.ceil(200 / frame_ms)))

    with sd.InputStream(
        samplerate=sample_rate,
        channels=1,
        dtype="float32",
        device=device,
        blocksize=frame_count,
    ) as stream:
        while True:
            now = time.monotonic()
            if now >= hard_deadline:
                break
            chunk, _overflowed = stream.read(frame_count)
            chunk = chunk.copy()
            peak = float(np.max(np.abs(chunk))) if chunk.size else 0.0
            level = chunk_level(chunk)
            peak_seen = max(peak_seen, peak)

            if not started:
                ambient_level = sum(ambient_levels) / len(ambient_levels) if ambient_levels else 0.0
                start_threshold = max(float(speech_threshold), ambient_level * 3.0)
                pre_roll.append(chunk)
                if level >= start_threshold:
                    started = True
                    frames.extend(list(pre_roll))
                    silent_blocks = 0
                    active_threshold = max(float(speech_threshold) * 0.65, ambient_level * 2.0)
                elif now >= speech_deadline:
                    break
                else:
                    ambient_levels.append(level)
                continue

            frames.append(chunk)
            if level >= active_threshold:
                silent_blocks = 0
            else:
                silent_blocks += 1
                if silent_blocks >= silence_blocks_needed:
                    break

    if not started or not frames:
        return {
            "audioPath": "",
            "speechDetected": False,
            "durationMs": 0,
            "peak": peak_seen,
            "sampleRate": sample_rate,
        }

    if silent_blocks > trailing_keep_blocks and len(frames) > (silent_blocks - trailing_keep_blocks):
        frames = frames[:-(silent_blocks - trailing_keep_blocks)]
    audio = np.concatenate(frames, axis=0)
    sf.write(resolved_output_path, audio, sample_rate)
    duration_ms = int(round(audio.shape[0] * 1000.0 / sample_rate))
    if peak_seen <= 1e-8:
        raise RuntimeError(
            "Microphone capture returned silence; on macOS this usually means the process is not running inside a microphone-authorized app context such as Terminal.app"
        )
    return {
        "audioPath": resolved_output_path,
        "speechDetected": True,
        "durationMs": duration_ms,
        "peak": peak_seen,
        "sampleRate": sample_rate,
    }


def transcribe_audio(audio_path, *, model=DEFAULT_MODEL, language="", initial_prompt=""):
    if mlx_whisper is None:
        raise RuntimeError("mlx_whisper is unavailable in the current Python environment")
    decode_options = {}
    normalized_language = trim(language)
    if normalized_language:
        decode_options["language"] = normalized_language
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        result = mlx_whisper.transcribe(
            str(Path(audio_path).expanduser().resolve()),
            path_or_hf_repo=model,
            verbose=False,
            initial_prompt=trim(initial_prompt) or None,
            condition_on_previous_text=False,
            temperature=0.0,
            no_speech_threshold=0.45,
            **decode_options,
        )
    return {
        "text": trim(result.get("text", "")),
        "language": trim(result.get("language", normalized_language)),
        "segments": result.get("segments", []),
    }


def make_temp_wav(prefix):
    handle = tempfile.NamedTemporaryFile(prefix=prefix, suffix=".wav", delete=False)
    handle.close()
    return handle.name


def extract_trailing_text(original_text, wake_phrase, match=None):
    original = trim(original_text)
    phrase = trim(wake_phrase)
    if not original:
        return ""
    if match and match.get("originalEnd") is not None:
        suffix = original[int(match["originalEnd"]):]
        suffix = suffix.strip().strip("，。！？；：,.!?;:-—…[](){}<>\"'“”‘’")
        return trim(suffix)
    if not phrase:
        return ""
    lowered_original = original.lower()
    lowered_phrase = phrase.lower()
    index = lowered_original.rfind(lowered_phrase)
    if index < 0:
        return ""
    suffix = original[index + len(phrase):]
    suffix = suffix.strip().strip("，。！？；：,.!?;:-—…[](){}<>\"'“”‘’")
    return trim(suffix)


def resolve_trigger_transcript(original_text, wake_phrase, transcript_mode="full", match=None):
    raw_text = trim(original_text)
    mode = trim(transcript_mode).lower() or "full"
    if mode == "after-wake":
        trailing = extract_trailing_text(raw_text, wake_phrase, match=match)
        return trailing or raw_text
    return raw_text


def emit_json(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
