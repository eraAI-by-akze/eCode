"""
eCode ↔ eraCore bridge.

eCode starts this script with the user's Python and talks JSON lines over
stdin/stdout. The model is loaded through eraCore.LLM (Ollama / any
OpenAI-compatible server / local GGUF via llama_cpp). This side runs the
agent loop; the tools themselves (reading and editing files) run inside eCode
so edits land in the editor buffers and can be reviewed and undone.

Protocol (one JSON object per line):

  eCode → bridge
    {"type": "configure", "backend": {...}}
    {"type": "chat", "id": str, "history": [{"role", "content"}], "context": {...}}
    {"type": "tool_result", "call_id": str, "ok": bool, "result": str}
    {"type": "cancel", "id": str}

  bridge → eCode
    {"type": "hello", "eracore": version | null, "python": version, "error"?: str}
    {"type": "configured", "ok": bool, "info"?: {...}, "error"?: str}
    {"type": "token", "id", "text"}
    {"type": "tool_call", "id", "call_id", "name", "args"}
    {"type": "done", "id", "reason"}
    {"type": "error", "id"?, "message"}
"""

from __future__ import annotations

import json
import os
import queue
import re
import sys
import threading
import traceback
import uuid

# The protocol owns the real stdout; anything libraries print goes to stderr.
_proto = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
sys.stdout = sys.stderr
_write_lock = threading.Lock()


def send(msg: dict) -> None:
    with _write_lock:
        _proto.write(json.dumps(msg, ensure_ascii=False) + "\n")
        _proto.flush()


try:
    import eraCore
    from eraCore.llm import LLM

    ERACORE_VERSION = getattr(eraCore, "__version__", "?")
    IMPORT_ERROR = None
except Exception as exc:  # noqa: BLE001 — report any import failure to the UI
    LLM = None  # type: ignore[assignment]
    ERACORE_VERSION = None
    IMPORT_ERROR = f"{type(exc).__name__}: {exc}"


MAX_STEPS = 12
TOOL_OPEN = "<tool>"
TOOL_CLOSE = "</tool>"

TOOLS_DOC = """\
Инструменты (пути — относительно корня проекта):
- list_files {"path"?: str, "pattern"?: str} — список файлов (pattern: glob вроде "*.py").
- read_file {"path": str, "start_line"?: int, "end_line"?: int} — содержимое с номерами строк.
- search {"query": str} — поиск текста по проекту, возвращает файл:строка: фрагмент.
- replace_lines {"path": str, "start_line": int, "end_line": int, "text": str} — заменить строки start..end (включительно) на text.
- insert_lines {"path": str, "after_line": int, "text": str} — вставить text после строки after_line (0 — в начало файла).
- replace_text {"path": str, "old": str, "new": str} — заменить точный фрагмент old на new (old должен встречаться ровно один раз).
- write_file {"path": str, "content": str} — создать файл или полностью перезаписать.

Чтобы вызвать инструмент, напиши ровно один блок и остановись:
<tool>{"name": "read_file", "args": {"path": "src/app.py"}}</tool>
Ты получишь результат и сможешь продолжить. Номера строк начинаются с 1.
Перед правкой сначала прочитай нужный фрагмент файла. Не выдумывай содержимое файлов.
Когда задача решена, ответь обычным текстом без блока <tool>: кратко, что сделано."""


def system_prompt(context: dict) -> str:
    parts = [
        "Ты eraAI — ассистент программиста внутри редактора eCode. "
        "Ты умеешь читать код проекта и изменять файлы с помощью инструментов. "
        "Отвечай на языке пользователя, по делу.",
        TOOLS_DOC,
    ]
    root = context.get("root")
    if root:
        parts.append(f"Проект: {context.get('rootName') or root}")
    active = context.get("activeFile")
    if active:
        line = context.get("cursorLine")
        parts.append(f"Открыт файл: {active}" + (f", курсор на строке {line}" if line else ""))
    selection = context.get("selection")
    if selection:
        parts.append(
            f"Выделенный фрагмент ({active}, строки {selection.get('startLine')}–{selection.get('endLine')}):\n"
            f"```\n{selection.get('text', '')}\n```"
        )
    files = context.get("openFiles")
    if files:
        parts.append("Открытые вкладки: " + ", ".join(files[:20]))
    return "\n\n".join(parts)


ROLE_TITLES = {"user": "Пользователь", "assistant": "Ассистент", "tool": "Результат инструмента"}


def render_transcript(history: list[dict]) -> str:
    """eraCore.LLM takes one prompt, so the dialogue is flattened into it."""
    chunks = []
    for m in history:
        title = ROLE_TITLES.get(m.get("role", "user"), "Пользователь")
        name = m.get("name")
        if m.get("role") == "tool" and name:
            title = f"{title} {name}"
        chunks.append(f"### {title}\n{m.get('content', '')}")
    chunks.append("### Ассистент\n")
    return "\n\n".join(chunks)


class Session:
    """One chat turn: may loop through several tool calls."""

    def __init__(self, sid: str, history: list[dict], context: dict) -> None:
        self.id = sid
        self.history = list(history)
        self.context = context
        self.cancelled = threading.Event()
        self.results: "queue.Queue[dict]" = queue.Queue()


class Bridge:
    def __init__(self) -> None:
        self.llm = None
        self.sessions: dict[str, Session] = {}
        self.pending_calls: dict[str, Session] = {}

    # ── model ──

    def configure(self, backend: dict) -> None:
        if LLM is None:
            send({"type": "configured", "ok": False, "error": IMPORT_ERROR or "eraCore не установлен"})
            return
        kind = backend.get("kind", "mock")
        common = {
            "max_tokens": int(backend.get("maxTokens") or 2048),
            "temperature": float(backend.get("temperature") if backend.get("temperature") is not None else 0.2),
        }
        try:
            if kind == "gguf":
                llm = LLM(path=backend["path"], **common)
            elif kind in ("ollama", "openai"):
                llm = LLM(
                    url=backend.get("url") or "http://localhost:11434/v1",
                    model=backend.get("model") or "qwen2.5-coder:7b",
                    api_key=backend.get("apiKey") or "none",
                    **common,
                )
            else:
                llm = LLM(**common)
        except Exception as exc:  # noqa: BLE001
            send({"type": "configured", "ok": False, "error": f"{type(exc).__name__}: {exc}"})
            return
        self.llm = llm
        info = llm.info() if hasattr(llm, "info") else {}
        send({"type": "configured", "ok": True, "info": info})

    # ── chat ──

    def start_chat(self, msg: dict) -> None:
        if self.llm is None:
            send({"type": "error", "id": msg.get("id"), "message": "Модель не развёрнута"})
            send({"type": "done", "id": msg.get("id"), "reason": "error"})
            return
        s = Session(msg["id"], msg.get("history", []), msg.get("context", {}))
        self.sessions[s.id] = s
        threading.Thread(target=self._run, args=(s,), daemon=True).start()

    def _generate(self, s: Session, prompt: str, system: str) -> tuple[str, dict | None]:
        """Stream one model reply; stop at the first complete <tool> block."""
        text = ""
        emitted = 0  # chars of `text` already sent to the UI
        tool_start = -1
        for chunk in self.llm.stream(prompt, system):
            if s.cancelled.is_set():
                break
            text += chunk
            if tool_start < 0:
                tool_start = text.find(TOOL_OPEN)
            if tool_start >= 0:
                if emitted < tool_start:
                    send({"type": "token", "id": s.id, "text": text[emitted:tool_start]})
                    emitted = tool_start
                if TOOL_CLOSE in text[tool_start:]:
                    break
                continue
            # Hold back a tail that could be the start of "<tool>".
            safe = len(text)
            for k in range(min(len(TOOL_OPEN) - 1, len(text)), 0, -1):
                if TOOL_OPEN.startswith(text[-k:]):
                    safe = len(text) - k
                    break
            if safe > emitted:
                send({"type": "token", "id": s.id, "text": text[emitted:safe]})
                emitted = safe
        if tool_start < 0 and emitted < len(text):
            send({"type": "token", "id": s.id, "text": text[emitted:]})
        call = parse_tool(text[tool_start:]) if tool_start >= 0 else None
        visible = text[:tool_start] if tool_start >= 0 else text
        return visible, call

    def _run(self, s: Session) -> None:
        reason = "stop"
        try:
            system = system_prompt(s.context)
            for _ in range(MAX_STEPS):
                visible, call = self._generate(s, render_transcript(s.history), system)
                if s.cancelled.is_set():
                    reason = "cancelled"
                    break
                if call is None:
                    s.history.append({"role": "assistant", "content": visible})
                    break
                if "error" in call:
                    s.history.append({"role": "assistant", "content": visible + call["raw"]})
                    s.history.append({"role": "tool", "name": "parser", "content": call["error"]})
                    continue
                call_id = uuid.uuid4().hex[:12]
                self.pending_calls[call_id] = s
                send({"type": "tool_call", "id": s.id, "call_id": call_id, "name": call["name"], "args": call["args"]})
                result = self._wait_result(s, call_id)
                if result is None:
                    reason = "cancelled"
                    break
                block = TOOL_OPEN + json.dumps({"name": call["name"], "args": call["args"]}, ensure_ascii=False) + TOOL_CLOSE
                s.history.append({"role": "assistant", "content": (visible + block).strip()})
                status = "OK" if result.get("ok") else "ОШИБКА"
                s.history.append({"role": "tool", "name": call["name"], "content": f"[{status}] {result.get('result', '')}"})
            else:
                send({"type": "token", "id": s.id, "text": "\n\n_(достигнут лимит шагов)_"})
                reason = "limit"
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            send({"type": "error", "id": s.id, "message": f"{type(exc).__name__}: {exc}"})
            reason = "error"
        finally:
            self.sessions.pop(s.id, None)
            send({"type": "done", "id": s.id, "reason": reason})

    def _wait_result(self, s: Session, call_id: str) -> dict | None:
        while not s.cancelled.is_set():
            try:
                r = s.results.get(timeout=0.25)
            except queue.Empty:
                continue
            if r.get("call_id") == call_id:
                return r
        self.pending_calls.pop(call_id, None)
        return None

    def tool_result(self, msg: dict) -> None:
        s = self.pending_calls.pop(msg.get("call_id", ""), None)
        if s:
            s.results.put(msg)

    def cancel(self, sid: str) -> None:
        s = self.sessions.get(sid)
        if s:
            s.cancelled.set()


_JSON_START = re.compile(r"\{")


def parse_tool(block: str) -> dict | None:
    """Parse '<tool>{json}</tool>'; small models often add fences or junk around the JSON."""
    raw = block
    body = block[len(TOOL_OPEN):]
    end = body.find(TOOL_CLOSE)
    if end >= 0:
        body = body[:end]
        raw = block[: len(TOOL_OPEN) + end + len(TOOL_CLOSE)]
    body = body.strip().strip("`").strip()
    if body.startswith("json"):
        body = body[4:].strip()
    m = _JSON_START.search(body)
    if not m:
        return {"error": "Блок <tool> пуст: ожидался JSON {\"name\", \"args\"}.", "raw": raw}
    try:
        obj, _ = json.JSONDecoder().raw_decode(body[m.start():])
    except json.JSONDecodeError as exc:
        return {"error": f"Некорректный JSON в <tool>: {exc}. Повтори вызов с валидным JSON.", "raw": raw}
    name = obj.get("name") or obj.get("tool")
    args = obj.get("args") or obj.get("arguments") or {}
    if not isinstance(name, str) or not isinstance(args, dict):
        return {"error": "В <tool> нужны поля name (строка) и args (объект).", "raw": raw}
    return {"name": name, "args": args}


def main() -> None:
    send({"type": "hello", "eracore": ERACORE_VERSION, "python": sys.version.split()[0], "error": IMPORT_ERROR})
    bridge = Bridge()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = msg.get("type")
        if kind == "configure":
            # Loading a GGUF can take a while; don't block tool results meanwhile.
            threading.Thread(target=bridge.configure, args=(msg.get("backend", {}),), daemon=True).start()
        elif kind == "chat":
            bridge.start_chat(msg)
        elif kind == "tool_result":
            bridge.tool_result(msg)
        elif kind == "cancel":
            bridge.cancel(msg.get("id", ""))


if __name__ == "__main__":
    main()
