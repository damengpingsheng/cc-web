#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

(async function main() {
  const args = process.argv.slice(2);
  const resumeIndex = args.indexOf('--resume');
  const inputFormatIndex = args.indexOf('--input-format');
  const sessionId = resumeIndex >= 0 && args[resumeIndex + 1]
    ? args[resumeIndex + 1]
    : crypto.randomUUID();

  const input = (await readStdin()).trim();
  const usesStreamJson = inputFormatIndex >= 0 && args[inputFormatIndex + 1] === 'stream-json';

  process.stdout.write(`${JSON.stringify({ type: 'system', session_id: sessionId })}\n`);

  // Resolve effectiveInput so /goal detection works for both text stdin and stream-json input.
  let streamPayload = null;
  let effectiveInput = input;
  if (usesStreamJson) {
    try { streamPayload = JSON.parse(input.split('\n').find(Boolean) || '{}'); } catch {}
    const blocks = streamPayload?.message?.content || [];
    effectiveInput = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text || '')
      .join(' ')
      .trim();
  }

  // Per-session compact state: mirrors mock-codex.js so the P0 auto-compact retry
  // chain (fail once with a token-limit error -> /compact -> replay) can be exercised.
  const statePath = path.join(os.tmpdir(), `cc-web-mock-claude-${sessionId}.json`);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {}

  if (/^\/goal(?:\s|$)/i.test(effectiveInput)) {
    // Simulate two-turn goal: assistant -> synthetic user(Stop hook feedback) -> assistant -> result.
    process.stdout.write(`${JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text: 'GOAL_TURN_1' }] },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'user',
      session_id: sessionId,
      isSynthetic: true,
      message: { role: 'user', content: [{ type: 'text', text: 'Stop hook feedback:\n[goal]: keep going' }] },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text: 'GOAL_TURN_2' }] },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'result',
      session_id: sessionId,
      total_cost_usd: 0,
      duration_api_ms: 1500,
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 50,
        output_tokens: 40,
      },
    })}\n`);
    return;
  }

  if (effectiveInput === 'trigger claude skill context') {
    const toolUseId = 'call_mock_skill_context';
    process.stdout.write(`${JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Skill', input: { skill: 'mock-skill' } }] },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'user',
      session_id: sessionId,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Launching skill: mock-skill' }] },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'user',
      session_id: sessionId,
      isSynthetic: true,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Base directory for this skill: /tmp/mock-skill\n\n# Mock Skill\n\nSKILL_CONTEXT_SHOULD_BE_HIDDEN' }],
      },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text: 'SKILL_CONTEXT_HIDDEN_OK' }] },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'result',
      session_id: sessionId,
      total_cost_usd: 0,
      duration_api_ms: 1500,
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 50,
        output_tokens: 40,
      },
    })}\n`);
    return;
  }

  // Token-limit error mode (P0 coverage): the first run of this prompt fails like the
  // real CLI does when the resumed transcript exceeds the model context window.
  // cc-web must detect it (isContextLimitError) and auto-inject /compact + replay.
  if (effectiveInput === 'trigger claude context limit' && !state.compacted) {
    process.stderr.write('API Error: Prompt is too long: 1048576 tokens > 1000000 maximum\n');
    process.exit(1);
  }

  if (
    effectiveInput === 'trigger claude midrun guard'
    || effectiveInput === 'trigger claude midrun overflow loop'
    || effectiveInput === 'trigger claude midrun grace'
    || effectiveInput === 'trigger claude midrun p0 loop'
    || (/上一轮执行过程中因上下文接近窗口安全上限/.test(effectiveInput) && state.midrunOverflowLoop)
  ) {
    if (effectiveInput === 'trigger claude midrun p0 loop') {
      state.midrunP0Loop = true;
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
    if (effectiveInput === 'trigger claude midrun overflow loop') {
      state.midrunOverflowLoop = true;
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (homeDir) {
      const projDir = path.join(homeDir, '.claude', 'projects', path.resolve(process.cwd()).replace(/^\//, '-').replace(/\//g, '-'));
      fs.mkdirSync(projDir, { recursive: true });
      const transcriptPath = path.join(projDir, `${sessionId}.jsonl`);
      if (!fs.existsSync(transcriptPath)) {
        fs.writeFileSync(transcriptPath, `${JSON.stringify({
          type: 'user',
          sessionId,
          cwd: process.cwd(),
          message: { role: 'user', content: effectiveInput },
        })}\n`);
      }
    }
    const isGraceMode = effectiveInput === 'trigger claude midrun grace';
    let currentStep = 0;
    let inFlight = false;
    const recordSigint = () => {
      try {
        const cur = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        Object.assign(state, cur);
      } catch {}
      state.sigintHistory = Array.isArray(state.sigintHistory) ? state.sigintHistory : [];
      state.sigintHistory.push({ step: currentStep, inFlight });
      state.sigintAtStep = currentStep;
      state.sigintInFlight = inFlight;
      fs.writeFileSync(statePath, JSON.stringify(state));
      process.removeListener('SIGINT', recordSigint);
      process.kill(process.pid, 'SIGINT');
    };
    process.on('SIGINT', recordSigint);

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    process.stdout.write(`${JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text: 'MIDRUN_HALF_PROGRESS_TEXT' }] },
    })}\n`);

    const totalSteps = isGraceMode ? 1 : 5;
    for (let i = 1; i <= totalSteps; i++) {
      currentStep = i;
      inFlight = true;
      const toolUseId = `call_midrun_${i}`;
      const usage = isGraceMode
        ? { input_tokens: 850000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 }
        : { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 };
      process.stdout.write(`${JSON.stringify({
        type: 'assistant',
        session_id: sessionId,
        message: {
          content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: `/tmp/file-${i}.txt` } }],
          usage,
        },
      })}\n`);
      await wait(isGraceMode ? 250 : 120);
      process.stdout.write(`${JSON.stringify({
        type: 'user',
        session_id: sessionId,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: isGraceMode ? 'ok' : 'X'.repeat(450 * 1024) }],
        },
      })}\n`);
      inFlight = false;
      await wait(350);
    }

    process.stdout.write(`${JSON.stringify({
      type: 'result',
      session_id: sessionId,
      total_cost_usd: 0,
      duration_api_ms: 500,
      usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 20 },
    })}\n`);
    return;
  }

  if (/上一轮执行过程中因上下文接近窗口安全上限/.test(effectiveInput) && state.midrunP0Loop) {
    process.stderr.write('API Error: Prompt is too long: 1048576 tokens > 1000000 maximum\n');
    process.exit(1);
  }

  if (/上一轮执行过程中因上下文接近窗口安全上限/.test(effectiveInput)) {
    const continuationText = `MIDRUN_CONTINUATION_COMPLETED: ${effectiveInput.includes('原始任务要求：') ? 'HAS_ROOT' : 'NO_ROOT'}`;
    process.stdout.write(`${JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text: continuationText }] },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'result',
      session_id: sessionId,
      total_cost_usd: 0,
      duration_api_ms: 500,
      usage: { input_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 30 },
    })}\n`);
    return;
  }

  if (effectiveInput === '/compact') {
    const boundaryUuid = crypto.randomUUID();
    state.compacted = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (homeDir) {
      const projDir = path.join(homeDir, '.claude', 'projects', path.resolve(process.cwd()).replace(/^\//, '-').replace(/\//g, '-'));
      const transcriptPath = path.join(projDir, `${sessionId}.jsonl`);
      if (fs.existsSync(transcriptPath)) {
        fs.appendFileSync(transcriptPath, `${JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          uuid: boundaryUuid,
          isSidechain: false,
          compactMetadata: { trigger: 'manual', preTokens: 93158, postTokens: 5762 },
        })}\n`);
      }
    }
    process.stdout.write(`${JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text: 'Claude compact finished.' }] },
    })}\n`);
    // Compact boundary event exactly as emitted on stream-json stdout by Claude CLI
    // (snake_case compact_metadata; the on-disk transcript uses camelCase compactMetadata).
    process.stdout.write(`${JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      uuid: boundaryUuid,
      compact_metadata: { trigger: 'manual', pre_tokens: 93158, post_tokens: 5762, duration_ms: 1234 },
      session_id: sessionId,
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'result',
      session_id: sessionId,
      total_cost_usd: 0,
      duration_api_ms: 1500,
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 50,
        output_tokens: 40,
      },
    })}\n`);
    return;
  }

  if (effectiveInput === 'trigger claude context limit' && state.compacted) {
    try { fs.unlinkSync(statePath); } catch {}
  }

  let text = '';
  if (usesStreamJson) {
    const blocks = streamPayload?.message?.content || [];
    const imageCount = blocks.filter((block) => block.type === 'image').length;
    text = `Claude mock handled stream-json (${imageCount} image): ${effectiveInput || '[no text]'}`;
  } else {
    text = `Claude mock handled: ${input}`;
  }

  process.stdout.write(`${JSON.stringify({
    type: 'assistant',
    session_id: sessionId,
    message: { content: [{ type: 'text', text }] },
  })}\n`);

  process.stdout.write(`${JSON.stringify({
    type: 'result',
    session_id: sessionId,
    total_cost_usd: 0,
    duration_api_ms: 1500,
    usage: {
      input_tokens: 120,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 50,
      output_tokens: 40,
    },
  })}\n`);
})();
