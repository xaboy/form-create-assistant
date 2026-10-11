import { AgentConfig, BaseAgent } from './base.js';

export class DeepSeekAgent extends BaseAgent {
  constructor(apiKey: string, model: string = 'deepseek-flash') {
    const config: AgentConfig = {
      baseUrl: 'https://api.deepseek.com',
      apiKey,
      model,
    };
    super(config);
  }

  protected getAuthHeader(apiKey: string): string {
    return `Bearer ${apiKey}`;
  }

  protected getEndpoint(): string {
    return '/v1/chat/completions';
  }
}

