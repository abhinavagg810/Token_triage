"""CLI: python -m agent.cli ask "..." | investigate --date YYYY-MM-DD"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from langgraph.checkpoint.sqlite import SqliteSaver

from .investigate import build_graph
from .llm import get_model
from .qa import ask
from .usage import UsageTracker, log_run


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m agent.cli",
        description="TokenTriage agents over a SQLite export (tokentriage analyze --db).",
    )
    parser.add_argument(
        "--db",
        default="tokentriage.db",
        help="path to the SQLite export (default: ./tokentriage.db)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_ask = sub.add_parser("ask", help="ask a spend question")
    p_ask.add_argument("question")

    p_inv = sub.add_parser("investigate", help="investigate a spend anomaly")
    p_inv.add_argument("--date", default=None, help="YYYY-MM-DD; omit to auto-detect the anomaly")

    args = parser.parse_args(argv)
    db_path = str(Path(args.db).resolve())

    if args.command == "ask":
        answer, usage = ask(args.question, db_path)
        print(answer)
        print(f"\n[{usage.summary()}]", file=sys.stderr)
        return 0

    # investigate — resumable via a SQLite checkpointer next to the export
    model = get_model()
    usage = UsageTracker(model=getattr(model, "model", "unknown"))
    checkpoint_path = db_path + ".checkpoints.sqlite"
    with SqliteSaver.from_conn_string(checkpoint_path) as saver:
        graph = build_graph(db_path, model, usage).compile(checkpointer=saver)
        thread_id = f"investigate-{args.date or 'auto'}"
        final = graph.invoke(
            {"date": args.date or "", "retries": 0},
            config={"configurable": {"thread_id": thread_id}},
        )
    log_run(db_path, "investigate", args.date, usage)
    print(final["report"])
    print(f"\n[{usage.summary()}]", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
