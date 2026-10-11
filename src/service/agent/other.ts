import { AgentConfig, BaseAgent } from './base.js';

export class OtherAgent extends BaseAgent {
  private parsedUrl: { baseUrl: string; endpoint: string };

  constructor(apiKey: string, model: string = 'deepseek-flash') {
    // 从环境变量获取配置，如果没有则使用默认值
    const fullUrl = process.env.AGENT_API || 'https://api.deepseek.com/v1/chat/completions';
    const parsedUrl = OtherAgent.parseUrl(fullUrl);

    const config: AgentConfig = {
      baseUrl: parsedUrl.baseUrl,
      apiKey,
      model,
    };
    super(config);

    // 在调用 super 之后赋值
    this.parsedUrl = parsedUrl;
  }

  protected getAuthHeader(apiKey: string): string {
    return `Bearer ${apiKey}`;
  }

  protected getEndpoint(): string {
    return this.parsedUrl.endpoint;
  }

  /**
   * 解析完整的 URL，分离出基础 URL 和端点路径
   * 例如: https://api.example.com/v1/chat/completions
   * 解析为: { baseUrl: 'https://api.example.com', endpoint: '/v1/chat/completions' }
   */
  private static parseUrl(url: string): { baseUrl: string; endpoint: string } {
    try {
      const urlObj = new URL(url);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
      const endpoint = urlObj.pathname;
      return { baseUrl, endpoint };
    } catch (error) {
      // 如果解析失败，使用默认值
      console.warn(`⚠️ URL 解析失败: ${url}，使用默认配置`);
      return { baseUrl: 'https://api.deepseek.com', endpoint: '/v1/chat/completions' };
    }
  }
}
