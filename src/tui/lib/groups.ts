/**
 * Build the visual row list for the Functions screen, grouping by AWS
 * "application" (CloudFormation/SAM/CDK stack tag).
 *
 * The Functions screen used to show a flat list. Once we started fetching
 * resource tags we can group functions that belong to the same stack
 * under a parent "app" row, with members rendered indented and their
 * stack-name prefix stripped from the displayed name.
 *
 * This module is deliberately pure — given snapshots, filter, and
 * collapsed-set state, it returns an ordered array of visual rows. The
 * React component drives cursor/selection against that array.
 */

import type { FunctionSnapshot } from "../../lib/lambda.js";

/** Tag keys we consult to identify the owning stack/application. */
const STACK_TAG_KEYS = [
  "aws:cloudformation:stack-name",
  "serverlessrepo:applicationId",
] as const;

export interface AppRow {
  kind: "app";
  /** Stack/application name. */
  app: string;
  /** Function names contained in this group, in display order. */
  members: string[];
  /** Total members regardless of filter (for "(N functions)"). */
  totalMembers: number;
  collapsed: boolean;
}

export interface FnRow {
  kind: "fn";
  fn: FunctionSnapshot;
  /** Stack name when this row belongs to an app, else undefined. */
  app?: string;
  /** Pre-stripped name for display (prefix removed when prefix matches). */
  displayName: string;
}

export type VisualRow = AppRow | FnRow;

export function appOf(fn: FunctionSnapshot): string | undefined {
  if (!fn.tags) return undefined;
  for (const key of STACK_TAG_KEYS) {
    const v = fn.tags[key];
    if (v) return v;
  }
  return undefined;
}

function stripPrefix(name: string, app: string): string {
  return name.startsWith(app + "-") ? name.slice(app.length + 1) : name;
}

export interface BuildVisualRowsResult {
  rows: VisualRow[];
  /** All function names that pass the filter, in visual order. */
  visibleFunctionNames: string[];
  /** Map from app name to all member function names (filtered). */
  appMembers: Map<string, string[]>;
}

/**
 * Build the flat visual-row list.
 *
 * @param functions  All snapshots for the region.
 * @param filter     Lowercased, trimmed substring filter (empty = no filter).
 * @param collapsed  Set of app names that are currently collapsed.
 */
export function buildVisualRows(
  functions: FunctionSnapshot[],
  filter: string,
  collapsed: ReadonlySet<string>,
): BuildVisualRowsResult {
  const matches = (fn: FunctionSnapshot): boolean => {
    if (!filter) return true;
    return fn.functionName.toLowerCase().includes(filter);
  };

  // Bucket by app.
  const grouped = new Map<string, FunctionSnapshot[]>();
  const ungrouped: FunctionSnapshot[] = [];
  for (const fn of functions) {
    if (!matches(fn)) continue;
    const app = appOf(fn);
    if (app) {
      const list = grouped.get(app) ?? [];
      list.push(fn);
      grouped.set(app, list);
    } else {
      ungrouped.push(fn);
    }
  }

  // Drop singleton "groups" — a stack with one Lambda is just a function.
  // Promoting it to a group adds visual noise without giving the user
  // anything to bulk-act on.
  for (const [app, members] of grouped) {
    if (members.length < 2) {
      ungrouped.push(...members);
      grouped.delete(app);
    }
  }

  const appNames = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  const rows: VisualRow[] = [];
  const visibleFunctionNames: string[] = [];
  const appMembers = new Map<string, string[]>();

  for (const app of appNames) {
    const members = grouped.get(app)!;
    members.sort((a, b) =>
      stripPrefix(a.functionName, app).localeCompare(
        stripPrefix(b.functionName, app),
      ),
    );
    const memberNames = members.map((m) => m.functionName);
    appMembers.set(app, memberNames);
    const isCollapsed = collapsed.has(app);
    rows.push({
      kind: "app",
      app,
      members: memberNames,
      totalMembers: members.length,
      collapsed: isCollapsed,
    });
    if (!isCollapsed) {
      for (const fn of members) {
        rows.push({
          kind: "fn",
          fn,
          app,
          displayName: stripPrefix(fn.functionName, app),
        });
        visibleFunctionNames.push(fn.functionName);
      }
    } else {
      // Even when collapsed, the members are still "selectable" from
      // the user's perspective via the app row, so we keep them in
      // visibleFunctionNames so `A` (select-all) still works as expected.
      for (const fn of members) visibleFunctionNames.push(fn.functionName);
    }
  }

  ungrouped.sort((a, b) => a.functionName.localeCompare(b.functionName));
  for (const fn of ungrouped) {
    rows.push({ kind: "fn", fn, displayName: fn.functionName });
    visibleFunctionNames.push(fn.functionName);
  }

  return { rows, visibleFunctionNames, appMembers };
}
