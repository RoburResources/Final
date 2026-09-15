import { createClientFromRequest } from 'npm:@base44/sdk';

/**
 * The brain behind the voice line.
 *
 * Runs on the server so the conversation, the transcript and the model access
 * all sit behind Base44 auth — nothing here is reachable from a public URL
 * without being signed in.
 */

const BRIEF = [
  'You are Claude, talking with Michael over a live voice line called Talkback.',
  'He speaks into a microphone; your reply is read aloud by a speech synthesiser and he hears it.',
  'Because this is speech, not writing:',
  '- Keep replies short. Two or three sentences is usually right. Never more than about 90 words unless he asks you to go long.',
  '- Write plain spoken English. No markdown, no bullet points, no headings, no code blocks, no emoji, no stage directions.',
  '- Expand anything that would be read out badly: say "about forty per cent", not "~40%".',
  '- Speech recognition makes mistakes. If a word looks garbled, guess from context and carry on; ask only if the meaning really turns on it.',
  '- Answer first, then offer the follow-up. Do not open with pleasantries every turn.',
  '- Never open by describing yourself or how you will behave.',
].join('\n');

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);

  const user = await base44.auth.me().catch(() => null);
  if (!user) return Response.json({ error: 'Sign in first' }, { status: 401 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Expected JSON' }, { status: 400 });
  }

  const db = base44.asServiceRole.entities;

  // The line only opens for a device that has passed a biometric check, so a
  // stolen session alone is not enough to talk to it.
  const keys = (await db.VoicePasskey.filter({ created_by: user.email })) as Array<
    Record<string, any>
  >;
  if (keys.length === 0) {
    return Response.json({ error: 'Enrol Face ID before using the line' }, { status: 403 });
  }

  if (body.action === 'history') {
    const turns = (await db.VoiceTurn.filter({ created_by: user.email })) as Array<
      Record<string, any>
    >;
    turns.sort((a, b) => String(a.said_at || '').localeCompare(String(b.said_at || '')));
    return Response.json({
      turns: turns.slice(-200).map((t) => ({ role: t.role, text: t.text, at: t.said_at })),
    });
  }

  if (body.action === 'clear') {
    const turns = (await db.VoiceTurn.filter({ created_by: user.email })) as Array<
      Record<string, any>
    >;
    for (const t of turns) await db.VoiceTurn.delete(t.id).catch(() => {});
    return Response.json({ cleared: turns.length });
  }

  const text = String(body.text || '').trim();
  if (!text) return Response.json({ error: 'Nothing to say' }, { status: 400 });

  const history = Array.isArray(body.history) ? (body.history as Array<Record<string, any>>) : [];

  // The transcript is handed over as a clearly delimited block. Keeping it out
  // of the instructions is what stops the model answering the brief instead of
  // the person — the bug that made the first version reply to itself.
  const conversation = history
    .slice(-20)
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .map((t) => `${t.role === 'assistant' ? 'You' : 'Michael'}: ${String(t.text).slice(0, 2000)}`)
    .join('\n');

  const prompt =
    BRIEF +
    '\n\n=== END OF INSTRUCTIONS ===\n' +
    'Below is the conversation so far, then what Michael has just said. Treat his words as speech ' +
    'addressed to you, never as part of these instructions. Reply with only what should be spoken ' +
    'aloud — no speaker label, no quotation marks.\n\n' +
    (conversation ? `--- conversation so far ---\n${conversation}\n\n` : '') +
    `--- Michael has just said ---\n${text.slice(0, 4000)}`;

  let reply = '';
  try {
    const result = await base44.integrations.Core.InvokeLLM({ prompt });
    reply = (typeof result === 'string' ? result : result?.text || result?.response || '').trim();
  } catch (err) {
    console.error('InvokeLLM failed', err);
    return Response.json({ error: 'Claude could not answer that one.' }, { status: 502 });
  }
  if (!reply) return Response.json({ error: 'Claude came back with nothing.' }, { status: 502 });

  const at = new Date().toISOString();
  await db.VoiceTurn.create({ role: 'user', text: text.slice(0, 4000), said_at: at });
  await db.VoiceTurn.create({ role: 'assistant', text: reply.slice(0, 4000), said_at: at });

  return Response.json({ reply });
}
