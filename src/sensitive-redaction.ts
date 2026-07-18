const URI_CREDENTIALS = /((?:postgres|postgresql|https?):\/\/)[^@\s/]+@/giu;
const PASSWORD_PARAMETER = /([?&](?:password|pwd|token|api[_-]?key)=)[^&\s]+/giu;
const AUTHORIZATION_VALUE = /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/giu;
const NAMED_SECRET = /((?:api[_-]?key|token|secret|password|pwd)\s*[=:]\s*)[^\s,;]+/giu;

export function redactSensitiveText(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let redacted = value;
  for (const key of ['CSM_DATABASE_URL', 'CSM_RELEASE_DATABASE_URL', 'OPENAI_API_KEY', 'OLLAMA_HOST'] as const) {
    const secret = env[key];
    if (secret && secret.length >= 4) redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  return redacted
    .replace(URI_CREDENTIALS, '$1[REDACTED]@')
    .replace(PASSWORD_PARAMETER, '$1[REDACTED]')
    .replace(AUTHORIZATION_VALUE, '$1[REDACTED]')
    .replace(NAMED_SECRET, '$1[REDACTED]');
}
