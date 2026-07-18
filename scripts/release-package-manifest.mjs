export function buildReleasePackageJson(source) {
  const setupCommand = source.scripts?.['db:setup'];
  if (setupCommand !== 'node dist/cli/init-db.js') {
    throw new Error('Release package requires the compiled db:setup command');
  }

  const release = structuredClone(source);
  release.scripts = { 'db:setup': setupCommand };
  delete release.devDependencies;
  return release;
}
