import { spawn } from 'node:child_process';

const REVIEW_COMPLETE_MARKER = 'GOALS_COACH_REVIEW_COMPLETE';
const PROGRAMMER_THREAD_NAME = 'PROGRAMMER';
const CHILD_GUARD_ENV = 'GOALS_COACH_REVIEW_HANDOFF_CHILD';
const MAX_REVIEW_CHARS = 12000;

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw || '{}');
} catch {
  console.log(JSON.stringify({ systemMessage: 'Review handoff skipped: invalid Stop-hook input.' }));
  process.exit(0);
}

if (process.env[CHILD_GUARD_ENV] === '1') {
  console.log(JSON.stringify({}));
  process.exit(0);
}

if (input.hook_event_name !== 'Stop' || input.stop_hook_active === true) {
  console.log(JSON.stringify({}));
  process.exit(0);
}

const reviewMessage = typeof input.last_assistant_message === 'string'
  ? input.last_assistant_message
  : '';

const markerPattern = new RegExp(`(?:^|\\r?\\n)${REVIEW_COMPLETE_MARKER}(?:\\r?\\n|$)`);
if (!markerPattern.test(reviewMessage)) {
  console.log(JSON.stringify({}));
  process.exit(0);
}

const boundedReview = reviewMessage.slice(-MAX_REVIEW_CHARS);
const sourceSession = typeof input.session_id === 'string' ? input.session_id : 'unknown';
const sourceTurn = typeof input.turn_id === 'string' ? input.turn_id : 'unknown';

const prompt = [
  'Independent review completed in another Codex thread for Goals Coach.',
  `Source review session: ${sourceSession}`,
  `Source review turn: ${sourceTurn}`,
  '',
  'Evaluate the review result below and continue only within the authority already granted by Derek Cook.',
  'Do not infer authorization to commit, push, create/update a PR, merge, deploy, migrate/rollback, change configuration, access or modify production, contact providers, activate features, or perform real-member actions.',
  'If the review requires one of those owner gates, stop and request that exact approval. Preserve AGENTS.md and all existing safety requirements.',
  '',
  '--- BEGIN REVIEW RESULT ---',
  boundedReview,
  '--- END REVIEW RESULT ---',
].join('\n');

const env = { ...process.env, [CHILD_GUARD_ENV]: '1' };
const child = spawn(
  'codex',
  ['exec', 'resume', PROGRAMMER_THREAD_NAME, prompt],
  {
    cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: process.platform === 'win32',
    env,
  },
);

const outcome = await new Promise((resolve) => {
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };

  child.once('spawn', () => finish('spawned'));
  child.once('error', () => finish('error'));
  setTimeout(() => finish('timeout'), 1500).unref();
});

if (outcome === 'spawned') {
  child.unref();
  console.log(JSON.stringify({ systemMessage: 'Independent review handoff dispatched to PROGRAMMER.' }));
} else {
  console.log(JSON.stringify({ systemMessage: 'Independent review completed, but PROGRAMMER could not be resumed automatically. No retry loop was started.' }));
}
