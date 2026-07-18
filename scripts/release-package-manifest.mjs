export function buildReleasePackageJson(source) {
  const setupCommand = source.scripts?.['db:setup'];
  const doctorCommand = source.scripts?.doctor;
  if (setupCommand !== 'node dist/cli/init-db.js') {
    throw new Error('Release package requires the compiled db:setup command');
  }
  if (doctorCommand !== 'node dist/cli/doctor.js') {
    throw new Error('Release package requires the compiled doctor command');
  }

  const release = structuredClone(source);
  release.scripts = { 'db:setup': setupCommand, doctor: doctorCommand };
  delete release.devDependencies;
  return release;
}
