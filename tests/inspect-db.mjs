// Read-only inspection of the live plugin database, used to verify the running
// Harness actually persisted what the pipeline reports.
import { DatabaseSync } from 'node:sqlite';

const path = process.argv[2] ?? `${process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`}/english-reader/database/english-reader.sqlite`;
const db = new DatabaseSync(path, { readOnly: true });
const count = (sql) => db.prepare(sql).all().map((row) => ({ ...row }));

console.log('articles      ', count('SELECT COUNT(*) AS n FROM articles')[0].n);
console.log('vocabulary    ', count('SELECT COUNT(*) AS n FROM vocabulary')[0].n);
console.log('phrases       ', count('SELECT COUNT(*) AS n FROM phrases')[0].n);
console.log('collocations  ', count('SELECT COUNT(*) AS n FROM collocations')[0].n);
console.log('sentences     ', count('SELECT COUNT(*) AS n FROM sentences')[0].n);
console.log('sentence state', count('SELECT analysis_status AS status, COUNT(*) AS n FROM article_sentences GROUP BY analysis_status'));
console.log('tasks         ', count('SELECT stage, status, output_json FROM analysis_tasks ORDER BY stage'));
console.log('analyses      ', count('SELECT status, version, model FROM article_analyses'));
console.log('knowledge     ', count('SELECT entity_type, favorite, mastery_level FROM user_knowledge'));
console.log('llm calls     ', count('SELECT stage, COUNT(*) AS n, SUM(output_tokens) AS tokens FROM llm_call_logs GROUP BY stage'));
