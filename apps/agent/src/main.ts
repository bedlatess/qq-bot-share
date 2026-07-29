import { loadAgentConfig } from './config.js';
import { Agent } from './agent.js';

const agent = new Agent(loadAgentConfig());
agent.start();

const stop = () => { agent.stop(); process.exit(0); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
