import { spawn } from 'child_process';
import * as path from 'path';

function getClaudeBin(): string {
  if (process.platform === 'win32') {
    return path.join(
      process.cwd(),
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
  }
  return path.join(process.cwd(), 'node_modules', '.bin', 'claude');
}

/** Run claude.exe and return stdout. stdin is optional. */
function spawnClaude(
  args: string[],
  stdinData?: string,
  timeoutMs = 120_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getClaudeBin(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', reject);

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Claude timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Claude exited ${code}: ${(stderr || stdout).slice(0, 500)}`));
      } else {
        resolve(stdout.trim());
      }
    });

    if (stdinData) proc.stdin.write(stdinData);
    proc.stdin.end();
  });
}

/** Text-only prompt (animate, add-element, etc.) */
export async function askClaude(prompt: string): Promise<string> {
  // Pipe prompt via stdin to avoid Windows command-line length limits
  return spawnClaude(['--print', '--output-format', 'text'], prompt);
}

/**
 * Vision prompt: sends image as base64 via --input-format stream-json.
 *
 * Previously the code saved the image to a temp file and put the file path
 * in the prompt text. That never worked — Claude (the LLM) has no way to
 * read a file mentioned in plain text. The stream-json input format accepts
 * the Anthropic API content-block structure, letting us embed the image as
 * base64 directly in the message.
 */
export async function askClaudeWithImage(
  prompt: string,
  imageBase64: string,
  mimeType: string,
): Promise<string> {
  const message =
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType || 'image/png',
              data: imageBase64,
            },
          },
          { type: 'text', text: prompt },
        ],
      },
    }) + '\n';

  // stream-json input requires stream-json output + --verbose
  const raw = await spawnClaude(
    ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json'],
    message,
    120_000,
  );

  // Output is newline-delimited JSON. Each line is one event object.
  // We want the "result" event which has the final response text.
  // Fallback: collect all assistant text blocks in order.
  let result = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed) as Record<string, unknown>;
      // Final result event
      if (evt.type === 'result' && typeof evt.result === 'string') {
        return evt.result;
      }
      // Assistant message event — collect text content
      if (evt.type === 'assistant') {
        const msg = evt.message as Record<string, unknown> | undefined;
        const content = msg?.content as Array<{ type: string; text?: string }> | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) result += block.text;
          }
        }
      }
    } catch {
      // ignore malformed lines
    }
  }
  return result || raw;
}
