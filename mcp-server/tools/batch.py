"""Run several browser tools in one call: sequential, stops at the first error by default."""

import json

from mcp.types import TextContent

from tools import REGISTRY, tool, schema, text, dispatch

MAX_STEPS = 50


def is_error(name: str, result: list) -> bool:
    """Whether a tool's output reports failure (error text, or a JSON object with an 'error' key)."""
    for c in result:
        if not isinstance(c, TextContent):
            continue
        t = c.text.lstrip()
        if t.startswith(("Error", "Unknown tool")):
            return True
        # A failed auto-screenshot after a successful action isn't a failed step; a failed screenshot step is
        if t.startswith("Screenshot error") and name == "browser_screenshot":
            return True
        if t.startswith("{"):
            try:
                if "error" in json.loads(t):
                    return True
            except ValueError:
                pass
    return False


@tool("browser_batch", f"Run up to {MAX_STEPS} browser tools in one round trip, in order: each action is {{tool, args}} with the same args you'd pass that tool directly. Outputs (screenshots included) come back labelled by step. Stops at the first failing step unless stop_on_error=false. A top-level profile applies to every step that doesn't set its own.", schema({
    "actions": {"type": "array", "description": "Steps to run, e.g. [{\"tool\": \"browser_action\", \"args\": {\"tab_id\": 1, \"action\": \"click\", \"selector\": \"#go\"}}]",
                "items": {"type": "object", "properties": {"tool": {"type": "string"}, "args": {"type": "object"}}, "required": ["tool"]}},
    "stop_on_error": {"type": "boolean", "default": True},
}, ["actions"]))
async def browser_batch(args):
    steps = args.get("actions")
    if not isinstance(steps, list) or not steps:
        return [text("Error: actions must be a non-empty list of {tool, args}")]
    if len(steps) > MAX_STEPS:
        return [text(f"Error: at most {MAX_STEPS} steps per batch, got {len(steps)}")]
    profile, stop = args.get("profile"), args.get("stop_on_error", True)
    out = []
    for i, step in enumerate(steps):
        name = (step or {}).get("tool") if isinstance(step, dict) else None
        step_args = dict((step or {}).get("args") or {}) if isinstance(step, dict) else {}
        if name == "browser_batch":
            result = [text("Error: browser_batch cannot be nested")]
        elif name not in REGISTRY:
            result = [text(f"Error: unknown tool {name!r}")]
        else:
            if profile and "profile" not in step_args and "profile" in REGISTRY[name].tool.input_schema.get("properties", {}):
                step_args["profile"] = profile
            result = await dispatch(name, step_args)
        bad = is_error(name, result)
        out.append(text(f"[{i}] {name}{' FAILED' if bad else ''}"))
        out.extend(result)
        if bad and stop:
            left = len(steps) - i - 1
            out.append(text(f"Stopped at step {i}; {left} step(s) not run (stop_on_error=true)"))
            break
    return out
