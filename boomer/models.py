"""Boomer's ears, brain and mouth.

Each class encodes something the benchmarks in spikes/ actually measured:

  Ears   transcribes DURING speech via StreamingParakeet, so the wait after you
         stop talking is the tail, not the whole clip.
  Brain  keeps a KV cache for the conversation. Uncached, TTFT grew 417 -> 703 ms
         over four turns; cached it stayed flat near 330 ms.
  Voice  splits the reply so a SHORT clause is synthesized first. Kokoro yields
         per sentence, so first-audio equals the opening chunk's synthesis time:
         1007 ms for one long sentence, 329 ms for a short opener.

Every model is warmed at load: the first inference builds the graph and costs
seconds, which would otherwise land on the user's first ever utterance.
"""
from __future__ import annotations

import os
import re
import time
from typing import Iterator

import mlx.core as mx
import numpy as np

from .protocol import MIC_SR, TTS_SR

LLM_MODEL = "mlx-community/Qwen3.6-35B-A3B-4bit"
STT_QWEN = "mlx-community/Qwen3-ASR-1.7B-8bit"
STT_PARAKEET = "mlx-community/parakeet-tdt-0.6b-v3"
TTS_VOICE = "af_heart"

# Words the generic model has no reason to know but Boomer hears constantly.
# Measured: without these, "Postgres or SQLite" came back as "posters or SQ
# light"; with them it is exact. Costs ~8 ms.
HOTWORDS = [
    "Boomer", "netreach", "apiary", "foundation", "factory", "gorlitzer",
    "Postgres", "SQLite", "Cloudflare", "wrangler", "worktree", "PR",
    "coordinator", "hive", "queue", "blocker", "netwatch", "bifrost",
]

# BOOMER_STT=parakeet falls back to the faster, less accent-robust model.
STT_BACKEND = os.environ.get("BOOMER_STT", "qwen").lower()

SYSTEM = (
    "You are Boomer, Franko's everyday assistant. You run entirely on his Mac "
    "and nothing you hear leaves it.\n"
    "Use your tools whenever they can answer better than you can: the time, this "
    "machine, his files, his timers, and his software projects. His agent factory "
    "is one of the things you help with, not the main one.\n"
    "Speak in one or two short spoken sentences. Never use markdown, lists, "
    "headings or emoji -- everything you say is read aloud. Be dry and direct.\n"
    "You have no access to the internet, so you cannot give news, weather, or "
    "anything current. Say so plainly rather than guessing. If you do not know "
    "something, say you do not know."
)

# Split on sentence enders, or on a comma/clause break if the opener is long.
_CLAUSE = re.compile(r"(?<=[.!?])\s+|(?<=[,;:])\s+")


class Ears:
    """Speech-to-text over a buffered utterance.

    Default backend is Qwen3-ASR, chosen for accented English: it scores 16.07
    WER on dialog-accented English against Whisper large-v3's 21.30, and
    narrows the gap between L1-English and other first languages to 1.1x versus
    Whisper's 2.2x. It also accepts hotwords, which is what makes the domain
    vocabulary come out right.

    Measured on this Mac against synthetic fixtures: Parakeet 134 ms,
    Qwen3-ASR 327 ms, Qwen3-ASR + hotwords 335 ms. The ~200 ms buys correct
    technical terms; whether it also helps a given real accent has to be tested
    by that speaker, not inferred from a leaderboard.

    Set BOOMER_STT=parakeet to A/B against the faster model.

    Streaming is deliberately not used. StreamingParakeet proved unreliable at
    utterance scale -- on a 1.86 s clip, chunked calls returned empty strings
    while a single whole-clip call transcribed correctly -- and batch decoding
    of a 2-4 s utterance is fast enough that the tail saving barely exists.
    """

    def __init__(self) -> None:
        self.backend = STT_BACKEND
        if self.backend == "parakeet":
            from parakeet_mlx import from_pretrained
            self.model = from_pretrained(STT_PARAKEET)
        else:
            from mlx_audio.stt.utils import load_model
            self.model = load_model(STT_QWEN)
        self._buf: list[np.ndarray] = []
        self._open = False

    def open(self) -> None:
        """Begin an utterance."""
        self._buf = []
        self._open = True

    def feed(self, pcm: np.ndarray) -> None:
        """pcm: float32 mono at MIC_SR, range -1..1."""
        if self._open:
            self._buf.append(np.asarray(pcm, dtype=np.float32))

    def close(self) -> str:
        """End the utterance and decode it."""
        if not self._open:
            return ""
        self._open = False
        if not self._buf:
            return ""
        audio = np.concatenate(self._buf)
        self._buf = []
        if len(audio) < MIC_SR // 5:      # too short to be speech
            return ""
        return self.transcribe(audio)

    def transcribe(self, audio: np.ndarray) -> str:
        audio = np.ascontiguousarray(audio, dtype=np.float32)
        if self.backend == "parakeet":
            from parakeet_mlx.audio import get_logmel
            mel = get_logmel(mx.array(audio), self.model.preprocessor_config)
            out = self.model.generate(mel)
            return (out[0].text or "").strip() if out else ""
        out = self.model.generate(mx.array(audio), hotwords=HOTWORDS)
        return self._reject_hotword_echo((getattr(out, "text", "") or "").strip())

    @staticmethod
    def _reject_hotword_echo(text: str) -> str:
        """Drop a transcript that is really just the bias list read back.

        Observed live: Boomer transcribed an utterance as the entire hotword
        list -- "Boomer, netreach, apiary, foundation, factory, gorlitzer,
        Postgres, SQLite, ..." -- and the model then answered it as if Franko had
        said it. Biasing lists can leak into the output of an
        attention-based ASR, and it is not reproducible on demand (silence,
        noise, clipping, garbling and pitch shifts all transcribe correctly), so
        this guards the symptom rather than waiting to find the trigger.

        Deliberately conservative: a sentence that merely mentions two of these
        terms is real speech and must survive.
        """
        words = [w.strip(",.;:!?").lower() for w in text.split()]
        if len(words) < 4:
            return text
        hot = {h.lower() for h in HOTWORDS}
        hits = sum(1 for w in words if w in hot)
        if hits >= 4 and hits / len(words) >= 0.5:
            print(f"  rejected | hotword echo ({hits}/{len(words)}) | {text[:60]!r}",
                  flush=True)
            return ""
        return text

    def warm(self) -> None:
        self.transcribe(np.zeros(MIC_SR, dtype=np.float32))


class Brain:
    """The LLM, with a retained per-conversation KV cache."""

    def __init__(self) -> None:
        from mlx_lm import load
        from mlx_lm.sample_utils import make_sampler
        self.model, self.tokenizer = load(LLM_MODEL)
        self.sampler = make_sampler(temp=0.7, top_p=0.9)
        self._wrapper = self._derive_turn_wrapper()
        self.reset()

    def _derive_turn_wrapper(self) -> tuple[str, str]:
        """The exact text that wraps one user turn, learned from the template.

        Needed because a tool response cannot go through apply_chat_template on
        its own: the template scans backwards for a user message that is not a
        <tool_response> to locate the last real query, and raises "No user query
        found in messages" when the only message it is given is a tool response.
        Sending the whole history instead would defeat the retained cache.

        Derived from a sentinel rather than hardcoded, so a template change
        surfaces as a wrong wrapper here instead of silently mis-prompting.
        """
        sentinel = "\x01SENTINEL\x01"
        try:
            r = self.tokenizer.apply_chat_template(
                [{"role": "user", "content": sentinel}],
                add_generation_prompt=True, tokenize=False, enable_thinking=False)
        except TypeError:
            r = self.tokenizer.apply_chat_template(
                [{"role": "user", "content": sentinel}],
                add_generation_prompt=True, tokenize=False)
        i = r.find(sentinel)
        if i < 0:
            return "", ""
        return r[:i], r[i + len(sentinel):]

    def stream_tool_result(self, wrapped: str, max_tokens: int = 220):
        """Continue the conversation with a tool response, reusing the cache."""
        from mlx_lm import stream_generate
        pre, post = self._wrapper
        if not pre:
            yield from self.stream(wrapped, max_tokens=max_tokens)
            return
        ids = self.tokenizer.encode(pre + wrapped + post)
        self._turns += 1
        for r in stream_generate(self.model, self.tokenizer, ids,
                                 max_tokens=max_tokens, sampler=self.sampler,
                                 prompt_cache=self.cache):
            yield r.text

    def reset(self, prewarm: bool = True) -> None:
        from mlx_lm.models.cache import make_prompt_cache
        self.cache = make_prompt_cache(self.model)
        self._turns = 0
        if prewarm:
            self._prefill_system()

    def _prefill_system(self) -> None:
        """Push the system prompt through the cache before anyone speaks.

        Measured: the first turn of a cold conversation costs ~1365 ms against
        ~330 ms steady state, because the system prompt prefills on the critical
        path. Paying it at boot moves that cost off the user's first utterance.

        The shared prefix is derived empirically -- render two different turn-1
        prompts and take the common token prefix -- because Qwen's chat template
        refuses to render a system message on its own ("No user query found").
        If the two renderings share too little, we skip rather than corrupt the
        cache with tokens the real prompt will repeat.
        """
        self._prewarmed = False
        self._system_tokens = 0
        try:
            a = self.tokenizer.encode(self._render("aaaa"))
            b = self.tokenizer.encode(self._render("bbbb"))
        except Exception:
            return
        n = 0
        for x, y in zip(a, b):
            if x != y:
                break
            n += 1
        if n < 8:                      # nothing meaningful shared; not worth it
            return
        self.model(mx.array([a[:n]]), cache=self.cache)
        mx.eval([c.state for c in self.cache])
        self._system_tokens = n
        self._prewarmed = True

    def _system(self) -> str:
        """System prompt plus anything she has been asked to remember.

        This is prefilled into the KV cache at boot, so memories cost no
        per-turn latency -- only a slightly longer one-off prefill.
        """
        from .memory import as_prompt
        return SYSTEM + as_prompt()

    def _tools(self):
        """Tool schemas, rendered into the system block by the chat template.

        They must be present on turn 0, because that is the only turn whose
        system block reaches the model -- and the boot-time prefill derives its
        shared prefix from _render, so including them here keeps the cache and
        the live prompt in agreement automatically.
        """
        from .tools import load_skills, schemas
        load_skills()          # importing a skill module registers its tools
        return schemas()

    def _render(self, user: str) -> str:
        # Turn 1 carries the system prompt; later turns ride the retained cache.
        msgs = ([{"role": "system", "content": self._system()}] if self._turns == 0 else []) + \
               [{"role": "user", "content": user}]
        kw = {"add_generation_prompt": True, "tokenize": False}
        if self._turns == 0:
            kw["tools"] = self._tools()
        try:
            return self.tokenizer.apply_chat_template(msgs, enable_thinking=False, **kw)
        except TypeError:
            return self.tokenizer.apply_chat_template(msgs, **kw)

    def stream(self, user: str, max_tokens: int = 160) -> Iterator[str]:
        from mlx_lm import stream_generate
        ids = self.tokenizer.encode(self._render(user))
        # Turn 1 must not re-send the tokens already sitting in the cache from
        # the boot-time prefill, or they would be duplicated in the KV.
        if self._turns == 0 and self._prewarmed:
            ids = ids[self._system_tokens:]
        self._turns += 1
        for r in stream_generate(self.model, self.tokenizer, ids,
                                 max_tokens=max_tokens, sampler=self.sampler,
                                 prompt_cache=self.cache):
            yield r.text

    def warm(self) -> None:
        """Exercise the REAL generation path, cache included.

        A bare uncached one-token call is not enough: the first cached
        generation compiles a different graph, and that cost (~1.3 s) would
        otherwise land on the user's first utterance. Measured, not assumed --
        the system-prompt prefill turned out NOT to be the cause.
        """
        for _ in self.stream("hello", max_tokens=8):
            pass
        self.reset()


class Voice:
    """Kokoro TTS, chunked so the first audio arrives fast."""

    def __init__(self) -> None:
        from kokoro import KPipeline
        self.pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")

    @staticmethod
    def split(text: str, opener_words: int = 6) -> list[str]:
        """Break a reply so the FIRST chunk is short.

        Kokoro synthesizes a whole chunk before emitting audio, so a short
        opener is worth ~680 ms of perceived latency. Later chunks can be long;
        they synthesize while the opener is still playing.
        """
        text = " ".join(text.split())
        if not text:
            return []
        parts = [p.strip() for p in _CLAUSE.split(text) if p.strip()]
        if not parts:
            return [text]
        # If the natural opener is still long, cut it at a word boundary.
        head = parts[0]
        if len(head.split()) > opener_words * 2:
            words = head.split()
            parts = [" ".join(words[:opener_words]), " ".join(words[opener_words:])] + parts[1:]
        return parts

    def say(self, chunk: str) -> Iterator[np.ndarray]:
        """Synthesize one chunk, yielding float32 audio at TTS_SR."""
        for _, _, audio in self.pipe(chunk, voice=TTS_VOICE, speed=1):
            yield np.asarray(audio, dtype=np.float32)

    def warm(self) -> None:
        for _ in self.say("ready"):
            pass
