// notify.ts — the one notification channel of the launchd jobs (plan 06 J2, §2 "Notifications":
// `osascript -e 'display notification …'` via execFile with an argument array; failures
// rate-limited per job to one per 6 h; the drift alarm and the credential-rejected alarm never
// rate-limited — they fire once per state change, which the caller decides; informational diffs one
// per run; "no notification ever contains a cookie value, a GUID or a member name — the redactor
// runs on notification text too"). Text is server-authored from fixed vocabulary and numbers, then
// redacted, stripped of control characters and capped. Ported from sibling @5daa625, adapted.
import type { Clock } from "../domain/clock.js";
import type { Exec } from "./io.js";
import { SecretRegistry, redactString, truncate } from "./log.js";
import { readJobState, stateNumber, updateJobState } from "./job-state.js";

/** One failure notification per job per this many ms (plan 06 §2). */
export const NOTIFY_RATE_LIMIT_MS = 6 * 60 * 60 * 1000;
/** The osascript binary (absolute: never resolved through PATH). */
export const OSASCRIPT = "/usr/bin/osascript";
/** Notification title. */
export const NOTIFY_TITLE = "espn-fantasy-football-mcp";
/** Longest notification body. */
export const NOTIFY_MAX_CHARS = 200;

const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const CONTROL_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]+/gu;

/** Escapes a string for an AppleScript double-quoted literal. */
export function appleScriptString(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Makes notification text safe: redacted (patterns), control/format characters removed, capped. */
export function safeNotificationText(text: string): string {
  const red = redactString(text, new SecretRegistry()).replace(CONTROL_RE, " ").trim();
  return truncate(red, NOTIFY_MAX_CHARS);
}

/** A job token (or `job`), for state keys and fixed-vocabulary text. */
export function jobToken(job: string): string {
  return CODE_RE.test(job) ? job : "job";
}

/** The fixed-vocabulary text of a failed job. */
export function failureText(job: string, error: string): string {
  return `${jobToken(job)} failed: ${CODE_RE.test(error) ? error : "error"} — run \`eff status\``;
}

/** What a notification call did. */
export type NotifyResult = "shown" | "rate_limited" | "unsupported" | "failed";

/** The notifier. Every method never throws. */
export interface Notifier {
  /** A failed job: rate-limited per job to one per NOTIFY_RATE_LIMIT_MS. */
  failure(job: string, error: string): Promise<NotifyResult>;
  /** Drift or credential rejection: never rate-limited (the caller fires it once per change). */
  alarm(text: string): Promise<NotifyResult>;
  /** One informational notification (a roster diff, a pool appearance, a pre-kickoff problem). */
  info(text: string): Promise<NotifyResult>;
}

/** Builds a notifier over osascript (darwin only) with the rate-limit stamps in job-state.json. */
export function createNotifier(opts: {
  readonly platform: NodeJS.Platform;
  readonly exec: Exec;
  readonly clock: Clock;
  readonly cacheDir: string;
}): Notifier {
  const show = async (text: string): Promise<NotifyResult> => {
    if (opts.platform !== "darwin") return "unsupported";
    try {
      const script = `display notification ${appleScriptString(safeNotificationText(text))} with title ${appleScriptString(NOTIFY_TITLE)}`;
      const r = await opts.exec(OSASCRIPT, ["-e", script], { timeoutMs: 5_000 });
      return r.code === 0 ? "shown" : "failed";
    } catch {
      return "failed";
    }
  };
  return {
    async failure(job, error) {
      if (opts.platform !== "darwin") return "unsupported";
      const key = `notify.failure.${jobToken(job)}`;
      const now = opts.clock.nowMs();
      const last = stateNumber(readJobState(opts.cacheDir), key);
      if (last !== null && now >= last && now - last < NOTIFY_RATE_LIMIT_MS) return "rate_limited";
      const r = await show(failureText(job, error));
      if (r === "shown") updateJobState(opts.cacheDir, { [key]: now });
      return r;
    },
    alarm: show,
    info: show,
  };
}
