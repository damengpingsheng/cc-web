'use strict';

// Codex snapshots written before ordered tool segments were introduced have no
// `segments`. Rolling out the same thread can also combine assistant records or
// include text that the old streaming snapshot omitted. Match turns by real
// user input, then take the native assistant turn only when its visible text is
// anchored to the snapshot at either end. Unmatched cc-web-only turns stay put.
function normalizeVisibleText(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function messageText(message) {
  const segments = Array.isArray(message?.segments) ? message.segments : [];
  const segmentText = segments
    .filter((segment) => segment?.type === 'text')
    .map((segment) => segment.content || '')
    .join('');
  return normalizeVisibleText(segmentText || message?.content || '');
}

function isSameUserTurn(snapshotMessage, nativeMessage) {
  if (snapshotMessage?.role !== 'user' || nativeMessage?.role !== 'user') return false;
  const snapshotText = messageText(snapshotMessage);
  return !!snapshotText && snapshotText === messageText(nativeMessage);
}

function isAnchoredAssistantText(snapshotText, nativeText) {
  if (!snapshotText || !nativeText) return !snapshotText && !nativeText;
  if (snapshotText === nativeText) return true;
  const shorter = snapshotText.length <= nativeText.length ? snapshotText : nativeText;
  if (shorter.length < 16) return snapshotText === nativeText;
  let prefix = 0;
  while (prefix < shorter.length && snapshotText[prefix] === nativeText[prefix]) prefix++;
  let suffix = 0;
  while (suffix < shorter.length
    && snapshotText[snapshotText.length - 1 - suffix] === nativeText[nativeText.length - 1 - suffix]) suffix++;
  return (prefix >= 24 && prefix / shorter.length >= 0.25)
    || (suffix >= 24 && suffix / shorter.length >= 0.25);
}

function userTurns(messages) {
  const turns = [];
  let current = null;
  for (let index = 0; index < (messages || []).length; index++) {
    const message = messages[index];
    if (message?.role === 'user') {
      current = { start: index, end: index + 1, messages: [message] };
      turns.push(current);
    } else if (current) {
      current.end = index + 1;
      current.messages.push(message);
    }
  }
  return turns;
}

function assistantForTurn(turn) {
  return turn?.messages.find((message) => message?.role === 'assistant') || null;
}

function assistantTextForTurn(turn) {
  return (turn?.messages || [])
    .filter((message) => message?.role === 'assistant')
    .map(messageText)
    .filter(Boolean)
    .join('');
}

function localMessagesForTurn(turn) {
  return (turn?.messages || []).slice(1)
    .filter((message) => message?.role !== 'assistant');
}

function appendLocalMessagesOnce(target, ...collections) {
  const seen = new Set();
  for (const messages of collections) {
    for (const message of messages) {
      const key = JSON.stringify({
        role: message?.role || '',
        kind: message?.kind || '',
        content: message?.content || '',
      });
      if (seen.has(key)) continue;
      seen.add(key);
      target.push(message);
    }
  }
}

function needsCodexToolLayoutMigration(previous, next) {
  const snapshotTurns = userTurns(previous);
  const nativeTurns = userTurns(next);
  if (next.length < previous.length) {
    const lastSnapshotUser = (previous || []).filter((message) => message?.role === 'user').pop();
    const lastNativeUser = (next || []).filter((message) => message?.role === 'user').pop();
    if (lastSnapshotUser && lastNativeUser
      && isSameUserTurn(lastSnapshotUser, lastNativeUser)
      && next[next.length - 1]?.role === 'user') {
      const snapshotAssistant = assistantForTurn(snapshotTurns[snapshotTurns.length - 1]);
      const nativeAssistant = assistantForTurn(nativeTurns[nativeTurns.length - 1]);
      if (snapshotAssistant && !nativeAssistant) {
        // A native rollout can lag behind the cc-web completion write while a
        // new turn is already in flight. The previous assistant still proves
        // ownership and is eligible for the same per-turn layout migration.
        return snapshotTurns.some((turn) => {
          const assistant = assistantForTurn(turn);
          return assistant && (!Array.isArray(assistant.segments) || assistant.segments.length === 0);
        });
      }
    }
  }
  if (snapshotTurns.length === 0 || nativeTurns.length === 0) return false;

  let snapshotIndex = 0;
  let matched = 0;
  let needsMigration = false;
  for (const nativeTurn of nativeTurns) {
    let found = -1;
    for (let i = snapshotIndex; i < snapshotTurns.length; i++) {
      if (isSameUserTurn(snapshotTurns[i].messages[0], nativeTurn.messages[0])) {
        found = i;
        break;
      }
    }
    if (found < 0) continue;

    const snapshotAssistant = assistantForTurn(snapshotTurns[found]);
    const nativeAssistant = assistantForTurn(nativeTurn);
    if (!snapshotAssistant && !nativeAssistant) {
      snapshotIndex = found + 1;
      matched++;
      continue;
    }
    if (!snapshotAssistant || !nativeAssistant
      || !isAnchoredAssistantText(assistantTextForTurn(snapshotTurns[found]), assistantTextForTurn(nativeTurn))) continue;

    snapshotIndex = found + 1;
    matched++;
    if (!Array.isArray(snapshotAssistant.segments) || snapshotAssistant.segments.length === 0) {
      needsMigration = true;
    }
  }
  // Tool payloads differ between the legacy streaming snapshot and rollout
  // function records, so safety comes from the ordered user-turn match and a
  // text anchor at the beginning or end of every replaced assistant turn.
  return needsMigration && matched >= 2 && matched >= Math.ceil(nativeTurns.length * 0.6);
}

function mergeCodexHistoryByUserTurn(previous, next) {
  const snapshot = Array.isArray(previous) ? previous : [];
  const native = Array.isArray(next) ? next : [];
  const snapshotTurns = userTurns(snapshot);
  const nativeTurns = userTurns(native);
  const merged = [];
  let snapshotTurnIndex = 0;
  let snapshotCursor = 0;

  for (const nativeTurn of nativeTurns) {
    let matchedIndex = -1;
    for (let i = snapshotTurnIndex; i < snapshotTurns.length; i++) {
      if (isSameUserTurn(snapshotTurns[i].messages[0], nativeTurn.messages[0])) {
        matchedIndex = i;
        break;
      }
    }
    if (matchedIndex < 0) {
      merged.push(...nativeTurn.messages);
      continue;
    }

    const matchedTurn = snapshotTurns[matchedIndex];
    merged.push(...snapshot.slice(snapshotCursor, matchedTurn.start));
    const snapshotAssistant = assistantForTurn(matchedTurn);
    const nativeAssistants = nativeTurn.messages.slice(1).filter((message) => message?.role === 'assistant');
    if (snapshotAssistant && nativeAssistants.length > 0
      && isAnchoredAssistantText(assistantTextForTurn(matchedTurn), assistantTextForTurn(nativeTurn))) {
      // Keep the cc-web user object so attachments and other local-only fields
      // survive; only the assistant body/tool layout comes from the rollout.
      merged.push(matchedTurn.messages[0], ...nativeAssistants);
      appendLocalMessagesOnce(merged, localMessagesForTurn(matchedTurn), localMessagesForTurn(nativeTurn));
    } else {
      merged.push(...matchedTurn.messages);
    }
    snapshotTurnIndex = matchedIndex + 1;
    snapshotCursor = matchedTurn.end;
  }
  merged.push(...snapshot.slice(snapshotCursor));
  return merged;
}

module.exports = {
  mergeCodexHistoryByUserTurn,
  needsCodexToolLayoutMigration,
};
