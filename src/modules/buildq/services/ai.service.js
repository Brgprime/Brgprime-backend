import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { buildqEnv, buildqFeatures } from '../config.js';
import { BuildqError } from '../lib/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Claude.
//
// The only new vendor in the whole integration — BRG Prime had no existing AI
// provider to reuse. Everything else (database, storage, email, payments) is
// shared with it.
//
// Model and defaults are pinned in config.js so every call site agrees.
// ─────────────────────────────────────────────────────────────────────────────

let client = null;

function getClient() {
  if (!buildqFeatures.ai) {
    throw BuildqError.unavailable(
      'The AI engine is not configured. Set ANTHROPIC_API_KEY.',
      'ai_unconfigured'
    );
  }
  if (!client) client = new Anthropic({ apiKey: buildqEnv.anthropicApiKey });
  return client;
}

// A refusal arrives as HTTP 200 with stop_reason "refusal", so it has to be
// checked rather than caught. Server-side fallbacks are deliberately not wired
// up here: they need the beta messages endpoint, and messages.parse() — which
// is what guarantees the engine's output matches its schema — is GA only.
// Construction drawings are not a category that trips the classifiers; if that
// ever changes, the fix is a fallback model, not silently returning nothing.
function assertNotRefused(response) {
  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category || 'unspecified';
    throw BuildqError.unavailable(
      `The AI engine declined to process this request (${category}).`,
      'ai_refused'
    );
  }
}

export function textOf(response) {
  return (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

// ─── Content blocks ──────────────────────────────────────────────────────────
// Claude reads PDFs and images natively. That is what makes an in-process
// engine possible at all — the alternative was a separate Python service
// running PyMuPDF and Tesseract, which the "no new services" rule excludes.

export function pdfBlock(buffer) {
  return {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
  };
}

export function imageBlock(buffer, mediaType = 'image/png') {
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') },
  };
}

// 32 MB request ceiling on the API; documents are capped at 25 MB on upload,
// but base64 inflates by a third, so the real limit is checked here.
const MAX_BASE64_BYTES = 30 * 1024 * 1024;

export function assertFits(buffer, name) {
  if (buffer.length * 1.37 > MAX_BASE64_BYTES) {
    throw BuildqError.badRequest(
      `"${name}" is too large for the analysis engine once encoded. Split it into fewer sheets.`,
      undefined,
      'file_too_large_for_ai'
    );
  }
}

// ─── Structured extraction ───────────────────────────────────────────────────
// Used wherever the shape of the answer matters — drawing analysis and BOQ
// generation. The schema is enforced by the API, so a malformed reply is not
// something the caller has to defend against.

// zodOutputFormat() reads Zod v4 internals (`schema._zod`). Hand it a schema
// built with the v3 entry point and it dies on `Cannot read properties of
// undefined (reading 'def')` — which says nothing, and which is exactly what
// silently failed every analysis and every BOQ generation until it was traced
// back here. Schemas must be built from 'zod/v4'; this says so out loud.
function outputFormat(schema) {
  try {
    return zodOutputFormat(schema);
  } catch (err) {
    if (!schema?._zod) {
      throw BuildqError.unavailable(
        'The analysis schema was built with the wrong Zod entry point. ' +
          "Schemas passed to extract() must be built with `import { z } from 'zod/v4'`.",
        'ai_schema_invalid'
      );
    }
    throw err;
  }
}

export async function extract({ system, content, schema, effort = 'high', maxTokens = 16000 }) {
  const format = outputFormat(schema);

  const response = await getClient().messages.parse({
    model: buildqEnv.model,
    max_tokens: maxTokens,
    system,
    thinking: { type: 'adaptive' },
    output_config: { format, effort },
    messages: [{ role: 'user', content }],
  });

  assertNotRefused(response);

  if (!response.parsed_output) {
    throw BuildqError.unavailable(
      'The AI engine returned a response that could not be read.',
      'ai_unparseable'
    );
  }

  return { data: response.parsed_output, usage: response.usage, model: response.model };
}

// ─── Conversation ────────────────────────────────────────────────────────────
export async function chat({ system, messages, maxTokens = 16000 }) {
  const response = await getClient().messages.create({
    model: buildqEnv.model,
    max_tokens: maxTokens,
    system,
    thinking: { type: 'adaptive' },
    messages,
  });

  assertNotRefused(response);
  return { text: textOf(response), usage: response.usage, model: response.model };
}

// Streaming variant for the assistant. Yields text deltas; the caller decides
// how to frame them (this module knows nothing about HTTP).
export async function* streamChat({ system, messages, maxTokens = 32000 }) {
  const stream = getClient().messages.stream({
    model: buildqEnv.model,
    max_tokens: maxTokens,
    system,
    thinking: { type: 'adaptive' },
    messages,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield { type: 'delta', text: event.delta.text };
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') {
    yield {
      type: 'error',
      message: 'The AI engine declined to answer that.',
    };
    return;
  }
  yield { type: 'done', usage: final.usage, model: final.model, text: textOf(final) };
}
