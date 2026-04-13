from __future__ import annotations
import argparse, json, sys, os

try:
    from reconciler import reconcile_stale_tasks, reconcile_delivery_failed, reconcile_notification_retry, reconcile_lost_tasks, reconcile_all
except ModuleNotFoundError:
    from lib.reconciler import reconcile_stale_tasks, reconcile_delivery_failed, reconcile_notification_retry, reconcile_lost_tasks, reconcile_all

try:
    from openclaw_taskflow_adapter import reconcile_native_bindings
except ModuleNotFoundError:
    from lib.openclaw_taskflow_adapter import reconcile_native_bindings

def main():
    parser = argparse.ArgumentParser(description="OctoClaw reconciler CLI")
    subparsers = parser.add_subparsers(dest="command")
    
    # Add subcommand parsers with shared options
    for name in ["stale", "delivery", "notification", "lost", "native", "all"]:
        sp = subparsers.add_parser(name)
        sp.add_argument("--dry-run", action="store_true", default=True)
        sp.add_argument("--apply", action="store_true", default=False)
        sp.add_argument("--task-id", default="")
        sp.add_argument("--session-key", default="")
        sp.add_argument("--workspace", default=os.environ.get("WORKSPACE", ""))
        sp.add_argument("--max-stale-minutes", type=int, default=30)
        sp.add_argument("--max-retries", type=int, default=3)
        if name == "native":
            sp.add_argument("--fix", action="store_true", default=False)
    
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)
    
    dry_run = not args.apply  # --apply overrides --dry-run
    workspace = args.workspace
    
    if args.command == "stale":
        result = reconcile_stale_tasks(max_stale_minutes=args.max_stale_minutes, workspace=workspace, dry_run=dry_run)
    elif args.command == "delivery":
        result = reconcile_delivery_failed(max_retries=args.max_retries, workspace=workspace, dry_run=dry_run)
    elif args.command == "notification":
        result = reconcile_notification_retry(max_retries=args.max_retries, workspace=workspace, dry_run=dry_run)
    elif args.command == "lost":
        result = reconcile_lost_tasks(workspace=workspace, dry_run=dry_run)
    elif args.command == "native":
        result = reconcile_native_bindings(workspace=workspace, fix=args.fix)
    elif args.command == "all":
        result = reconcile_all(workspace=workspace, dry_run=dry_run)
    
    print(json.dumps(result, ensure_ascii=False, indent=2))
    
    if result.get("errors"):
        sys.exit(1)
    total = result.get("reconciled_count", 0) or result.get("total_reconciled", 0)
    if total > 0:
        sys.exit(2)
    sys.exit(0)

if __name__ == "__main__":
    main()