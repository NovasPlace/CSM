const URI_CREDENTIALS = /((?:postgres|postgresql):\/\/)[^@\s/]+@/gi;
const PASSWORD_PARAMETER = /([?&](?:password|pwd)=)[^&\s]+/gi;

export function formatDatabaseDiagnostic(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text
    .replace(URI_CREDENTIALS, '$1[REDACTED]@')
    .replace(PASSWORD_PARAMETER, '$1[REDACTED]');
}
