import { loadAgentConfig } from './config.js';
import { Agent } from './agent.js';

const agent = new Agent(loadAgentConfig());
agent.start();

const stop = () => { agent.stop(); process.exit(0); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

let terminating = false;
const fatal = (kind: string, error: unknown) => {
  if (terminating) return;
  terminating = true;
  console.error(`[fatal:${kind}]`, error instanceof Error ? error.stack || error.message : String(error));
  agent.stop();
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100);
};
process.once('uncaughtException', (error) => fatal('uncaughtException', error));
process.once('unhandledRejection', (error) => fatal('unhandledRejection', error));
