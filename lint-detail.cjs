const { ESLint } = require('./node_modules/eslint');
async function run() {
  const e = new ESLint();
  const results = await e.lintFiles(['src/']);
  for (const r of results) {
    if (r.warningCount > 0) {
      const f = r.filePath.replace(/.*\\src\\/, '');
      const msgs = r.messages.filter(m => m.severity === 1).map(m => `  L${m.line}:${m.column} ${m.ruleId}`);
      console.log(`${r.warningCount}\t${f}`);
      for (const m of msgs) console.log(m);
    }
  }
}
run().catch(e => console.error(e.message));
