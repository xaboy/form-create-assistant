import axios from 'axios';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ComponentRegistry } from '../core/component-registry.js';
import { FormRuleGenerator } from '../core/form-rule-generator.js';
import { generateSessionId } from '../utils';
import { AgentMessage, AgentRequest, AgentTool, AgentType, BaseAgent, createAgent } from './agent';
import { ToolRegistry } from './tools';
import type { ToolArgs } from './tools/types';

// OpenAI 兼容的消息格式
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

// OpenAI 兼容的请求格式（唯一支持的格式）
export interface ChatRequest {
  model: string;
  ui: string;
  messages: OpenAIMessage[];
  agent?: AgentType;
  form?: {
    rule?: string;
    option?: string;
  };
  context: Record<string, any>;
}

// OpenAI 兼容的流式响应格式
export interface OpenAIChatStreamChunk {
  id: string;
  object: 'formCreateAgent';
  created: number;
  model?: string;
  usage?: null | Object;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
    };
    finish_reason: 'stop' | 'length' | 'function_call' | 'content_filter' | null;
  }>;
}

export default class Chat {
  private toolRegistry: ToolRegistry;
  private formGenerator: FormRuleGenerator;
  private componentRegistry: ComponentRegistry;
  private agentCache: Map<string, BaseAgent> = new Map();

  constructor() {
    this.toolRegistry = new ToolRegistry();
    this.formGenerator = new FormRuleGenerator();
    this.componentRegistry = new ComponentRegistry();
  }

  /**
   * 初始化服务
   */
  async initialize(): Promise<void> {}

  /**
   * 读取系统提示词
   */
  private readSystemPrompt(): string {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const systemPromptPath = join(__dirname, 'SYSTEM_PROMPT.md');
      const systemPrompt = readFileSync(systemPromptPath, 'utf-8');
      console.log('✅ 成功读取系统提示词文件');
      return systemPrompt;
    } catch (error) {
      console.error('❌ 读取系统提示词失败:', error);
      // 返回默认提示词作为后备
      return '';
    }
  }

  /**
   * 生成会话信息部分
   */
  private buildSessionInfo(sessionId: string, ui: string, vueVersion: 'vue2' | 'vue3'): string {
    return `<session_id readonly>
${sessionId}
</session_id>
<ui readonly>
${ui}
</ui>
<vue_version readonly>
${vueVersion}
</vue_version>`;
  }

  /**
   * 生成组件列表部分
   */
  private buildComponentList(
    categorizedComponents: ReturnType<ComponentRegistry['categorizeComponents']>,
  ): string {
    const sections = [
      {
        title: 'Field 表单组件',
        category: categorizedComponents.formComponents,
      },
      {
        title: 'Container 布局组件',
        category: categorizedComponents.layoutComponents,
      },
      {
        title: 'Assist 辅助组件',
        category: categorizedComponents.assistComponents,
      },
    ];

    const componentListParts = sections.map(section => {
      const componentItems = section.category.components
        .map(comp => `- ${comp.type}: ${comp.label}`)
        .join('\n');

      return `## ${section.title} (${section.category.count}个)
${section.category.description}
${componentItems}`;
    });

    return `## 可用组件列表
${componentListParts.join('\n\n')}

请只使用以上组件来构建您的表单规则。`;
  }

  /**
   * 生成用户规则部分
   */
  private buildUserRule(formRule: any): string {
    if (!formRule) {
      return '';
    }

    return `
<current_user_rule>
${JSON.stringify(formRule)}
</current_user_rule>`;
  }

  /**
   * 构建增强的系统提示词
   */
  private buildEnhancedSystemPrompt(
    sessionId: string,
    version: { ui: string; vue: 'vue2' | 'vue3' },
    formRule?: any,
  ): string {
    const systemPrompt = this.readSystemPrompt();
    const sessionInfo = this.buildSessionInfo(sessionId, version.ui, version.vue);
    const components = this.componentRegistry.getComponents(version.ui, version.vue);
    const categorizedComponents = this.componentRegistry.categorizeComponents(components);
    const componentList = this.buildComponentList(categorizedComponents);
    const userRule = this.buildUserRule(formRule);

    return `${systemPrompt}
${sessionInfo}

${componentList}

${userRule}`;
  }

  /**
   * 生成 OpenAI 兼容的响应 ID
   */
  private generateOpenAIId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    return `chatcmpl-${timestamp}-${random}`;
  }

  /**
   * 将 OpenAI 消息格式转换为 Agent 格式
   */
  private convertToAgentMessages(messages: OpenAIMessage[]): AgentMessage[] {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content,
      tool_call_id: msg.tool_call_id,
      tool_calls: msg.tool_calls,
    }));
  }

  /**
   * 获取或创建 Agent
   */
  private getAgent(agentType: AgentType, apiKey: string, model: string): BaseAgent {
    const cacheKey = `${agentType}-${model}`;

    if (!this.agentCache.has(cacheKey)) {
      const agent = createAgent(agentType, apiKey, model);
      this.agentCache.set(cacheKey, agent);
      console.log(`✅ 创建 ${agentType} Agent: ${model}`);
    } else {
      const agent = this.agentCache.get(cacheKey)!;
      agent.updateApiKey(apiKey);
    }

    return this.agentCache.get(cacheKey)!;
  }

  /**
   * 生成 OpenAI 兼容的流式响应块
   */
  generateStreamChunk(
    content: string,
    isFirst: boolean = false,
    isLast: boolean = false,
    model: string = 'deepseek-flash',
    usage: any = null,
  ): string {
    const chunk: OpenAIChatStreamChunk = {
      id: this.generateOpenAIId(),
      object: 'formCreateAgent',
      created: Math.floor(Date.now() / 1000),
      // model,
      usage: usage || null,
      choices: [
        {
          index: 0,
          delta: isFirst ? { role: 'assistant', content } : { content },
          finish_reason: isLast ? 'stop' : null,
        },
      ],
    };

    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  /**
   * 关闭服务
   */
  async shutdown(): Promise<void> {}

  /**
   * 动态获取 MCP 工具定义
   */
  private async getMCPTools(): Promise<AgentTool[]> {
    try {
      // 直接从 ToolRegistry 获取完整的工具定义
      const mcpTools = this.toolRegistry.getAllToolDefinitions();

      if (mcpTools.length === 0) {
        return [];
      }

      // 将 MCP 工具转换为 DeepSeek 工具格式
      const tools: AgentTool[] = [];

      for (const mcpTool of mcpTools) {
        if (!mcpTool.private) {
          tools.push({
            type: 'function',
            function: {
              name: mcpTool.name,
              description: mcpTool.description || `调用 MCP 工具: ${mcpTool.name}`,
              parameters: {
                type: 'object',
                properties: mcpTool.inputSchema?.properties || {},
                required: mcpTool.inputSchema?.required || [],
                additionalProperties: false,
              },
            },
          });
        }
      }

      console.log(`✅ 成功获取 ${tools.length} 个 MCP 工具定义`);
      return tools;
    } catch (error) {
      console.error('获取 MCP 工具失败:', error);
      return [];
    }
  }

  private getToolTitle(name: string): string | undefined {
    const tools = this.toolRegistry.getAllToolDefinitions();
    for (const tool of tools) {
      if (tool.name === name) {
        return tool.title;
      }
    }
  }

  /**
   * 处理工具调用
   */
  private async handleToolCall(
    toolName: string,
    arguments_: any,
    context: Record<string, any>,
  ): Promise<any> {
    try {
      const handler = this.toolRegistry.getToolHandler(toolName);
      if (!handler) {
        throw new Error(`未知的工具: ${toolName}`);
      }

      const result = await handler(arguments_ as ToolArgs, {
        formGenerator: this.formGenerator,
        componentRegistry: this.componentRegistry,
        context,
      });

      return {
        data: result.content,
      };
    } catch (error) {
      console.error(`工具调用失败 ${toolName}:`, error);
      throw error;
    }
  }

  /**
   * 递归处理聊天流，支持工具调用和连接状态检查
   */
  private async *processChatStream(
    messages: AgentMessage[],
    apiKey: string,
    model: string,
    tools: AgentTool[],
    agentType: AgentType,
    maxDepth: number = 1,
    context: Record<string, any>,
    sessionId?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<string | { content: string; usage?: any }, void, unknown> {
    // 获取或创建 agent
    const agent = this.getAgent(agentType, apiKey, model);

    // 构建 Agent 请求
    const agentRequest: AgentRequest = {
      model,
      messages,
      stream: true,
      stream_options: {
        include_usage: true,
      },
      temperature: 0.2,
      tool_stream: true,
      parallel_tool_calls: true,
      max_tokens: 4000,
      tools: tools,
      tool_choice: 'auto',
    };

    console.log(`🔄 发送请求 (深度: ${maxDepth})，消息数量:`, messages.length);

    let response;
    try {
      response = await agent.chat(agentRequest, signal);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const statusText = error.response?.statusText;
        const requestUrl = error.config?.url;
        const requestMethod = error.config?.method?.toUpperCase();

        console.error('❌ API 请求失败:');
        console.error(`  状态码: ${status} ${statusText || ''}`);
        console.error(`  请求: ${requestMethod} ${requestUrl}`);
      } else {
        console.error('❌ 网络请求异常:', error);
      }
      throw error;
    }

    // 处理流式响应
    let buffer = '';
    const conversationMessages: AgentMessage[] = [...messages];
    const currentMessage: AgentMessage = { role: 'assistant', content: '' };
    const toolCalls: any[] = [];

    for await (const chunk of response) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            // 处理工具调用
            if (toolCalls.length > 0) {
              yield `\n`;
              // 首先将 assistant 的响应（包含工具调用）添加到对话历史中
              if (currentMessage.content || toolCalls.length > 0) {
                conversationMessages.push({
                  role: 'assistant',
                  content: currentMessage.content,
                  tool_calls: toolCalls,
                });
              }

              // 为每个工具调用生成执行中的提示
              // 执行工具调用
              for (const toolCall of toolCalls) {
                console.log(`## 调用: ${toolCall.function.name}`, toolCall.function.arguments);
                try {
                  const toolResult = await this.handleToolCall(
                    toolCall.function.name,
                    { ...JSON.parse(toolCall.function.arguments), sessionId },
                    context,
                  );
                  const title = this.getToolTitle(toolCall.function.name);
                  if (title) {
                    yield `[FC_TOOL]{"title":"${title}","id":"${toolCall.id}","status":"end"}`;
                  }
                  console.log(`${toolResult.data[0].text.substring(0, 120)}...`);
                  conversationMessages.push({
                    role: 'tool',
                    content: toolResult.data[0].text || '执行完毕',
                    tool_call_id: toolCall.id,
                  });
                  if (toolResult.data[0]?.answer) {
                    const chats = Array.isArray(toolResult.data[0]?.answer)
                      ? toolResult.data[0]?.answer
                      : [toolResult.data[0]?.answer];
                    for (const chat of chats) {
                      yield `\n${chat}\n`;
                    }
                  }
                  if (toolResult.data[0]?.end) {
                    return;
                  }
                } catch (error) {}
              }

              // 递归调用，继续传递工具和连接检查函数，但增加深度限制
              if (maxDepth < 6) {
                // 防止无限递归
                yield* this.processChatStream(
                  conversationMessages,
                  apiKey,
                  model,
                  tools,
                  agentType,
                  maxDepth + 1,
                  context,
                  sessionId,
                  signal,
                );
              } else {
                console.log(`达到最大递归深度 (${maxDepth})，停止递归`);
                yield '\n达到最大处理深度，请重新开始对话\n';
              }
            } else {
              // 没有工具调用时，将 assistant 的响应添加到对话历史中
              if (currentMessage.content) {
                conversationMessages.push({
                  role: 'assistant',
                  content: currentMessage.content,
                });
              }
            }
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            const deltaToolCalls = parsed.choices?.[0]?.delta?.tool_calls;

            if (content) {
              currentMessage.content += content;
              // 如果有 usage，一起返回
              if (parsed.usage) {
                yield { content, usage: parsed.usage };
              } else {
                yield content;
              }
            } else if (parsed.usage) {
              // 只有 usage 没有 content 时也要返回
              yield { content: '', usage: parsed.usage };
            }

            // 收集工具调用
            if (deltaToolCalls) {
              for (const deltaToolCall of deltaToolCalls) {
                if (deltaToolCall.index !== undefined) {
                  if (!toolCalls[deltaToolCall.index]) {
                    toolCalls[deltaToolCall.index] = {
                      id: deltaToolCall.id,
                      type: deltaToolCall.type,
                      function: { name: '', arguments: '' },
                    };
                  }

                  if (deltaToolCall.function?.name) {
                    toolCalls[deltaToolCall.index].function.name += deltaToolCall.function.name;
                    const title = this.getToolTitle(deltaToolCall.function.name);
                    if (title) {
                      yield `[FC_TOOL]{"title":"${title}","id":"${deltaToolCall.id}","status":"loading"}`;
                    }
                  }

                  if (deltaToolCall.function?.arguments) {
                    toolCalls[deltaToolCall.index].function.arguments +=
                      deltaToolCall.function.arguments;
                  }
                }
              }
            }
          } catch (error) {
            // 忽略解析错误
          }
        }
      }
    }
  }

  getUiVersion(ui: string): { ui: string; vue: 'vue2' | 'vue3' } {
    const alias = {
      'element-plus': {
        ui: 'element-plus',
        vue: 'vue3',
      },
      'element-ui': {
        ui: 'element-ui',
        vue: 'vue2',
      },
      vant: {
        ui: 'vant',
        vue: 'vue3',
      },
      'vant@vue2': {
        ui: 'vant',
        vue: 'vue2',
      },
      'ant-design-vue': {
        ui: 'ant-design-vue',
        vue: 'vue3',
      },
      'ant-design-vue@vue2': {
        ui: 'ant-design-vue',
        vue: 'vue2',
      },
    } as { [key: string]: { ui: string; vue: 'vue2' | 'vue3' } };
    return alias[ui] || alias['element-plus'];
  }

  /**
   * OpenAI 格式的流式聊天接口
   */
  async *chatStream(
    request: ChatRequest,
    apiKey: string,
    signal: AbortSignal,
  ): AsyncGenerator<
    | string
    | {
        content: string;
        usage?: any;
      },
    void,
    unknown
  > {
    try {
      // 从请求中获取 Agent 类型，默认为 deepseek
      const agentType = request.agent || 'deepseek';
      console.log(`🤖 使用 Agent: ${agentType}`);

      // 生成会话 ID
      const currentSessionId = generateSessionId();
      console.log('📋 会话 ID:', currentSessionId);

      // 动态获取 MCP 工具
      const tools = await this.getMCPTools();

      // 构建消息数组
      const messages = this.convertToAgentMessages(request.messages);

      // 如果没有系统消息，添加系统提示词
      const hasSystemMessage = messages.some(msg => msg.role === 'system');
      if (!hasSystemMessage) {
        const version = this.getUiVersion(request.ui);
        console.log(version);

        const enhancedSystemPrompt = this.buildEnhancedSystemPrompt(
          currentSessionId,
          version,
          request.context.form?.rule,
        );

        messages.unshift({
          role: 'system',
          content: enhancedSystemPrompt,
        });
        console.log(`✅ 使用系统提示词文件: ${messages[0].content.substring(0, 30)}...`);
      }

      console.log('🔑 使用 API 密钥:', apiKey ? `${apiKey.substring(0, 10)}...` : '未提供');

      // 调用递归处理方法
      yield* this.processChatStream(
        messages,
        apiKey,
        request.model,
        tools,
        agentType,
        1,
        request.context,
        currentSessionId,
        signal,
      );

      console.log('📋 会话结束 ID:', currentSessionId);
    } catch (error: any) {
      console.error('❌ Api 服务错误:', error.name);

      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const statusText = error.response?.statusText;
        const responseData = error.response?.data;
        const requestUrl = error.config?.url;
        const requestMethod = error.config?.method?.toUpperCase();
        const requestHeaders = error.config?.headers;

        // 详细的错误信息
        console.error('📋 详细错误信息:');
        console.error(`  状态码: ${status} ${statusText || ''}`);
        console.error(`  请求方法: ${requestMethod} ${requestUrl}`);

        // 根据状态码提供具体的错误信息
        let errorMessage = '';
        if (status === 401) {
          errorMessage = `\n❌ API 认证失败 (401): 请检查 API 密钥是否正确\n💡 提示: API 密钥应该以 'sk-' 开头\n`;
        } else if (status === 429) {
          errorMessage = `\n❌ API 请求频率限制 (429): 请稍后再试\n💡 提示: 可能需要等待一段时间后重试\n`;
        } else if (status === 400) {
          const detailMessage =
            responseData?.error?.message || responseData?.message || '请求参数错误';
          errorMessage = `\n❌ API 请求错误 (400): ${detailMessage}\n💡 提示: 请检查请求参数是否正确\n`;
        } else if (status === 403) {
          errorMessage = `\n❌ API 访问被拒绝 (403): 可能是权限不足或账户问题\n💡 提示: 请检查账户状态和权限设置\n`;
        } else if (status === 404) {
          errorMessage = `\n❌ API 接口不存在 (404): 请检查 API 端点是否正确\n💡 提示: 当前端点: ${requestUrl}\n`;
        } else if (status === 500) {
          errorMessage = `\n❌ 服务器内部错误 (500): 服务器出现问题\n💡 提示: 请稍后重试或联系技术支持\n`;
        } else if (status === 502 || status === 503 || status === 504) {
          errorMessage = `\n❌ 服务不可用 (${status}): 服务暂时不可用\n💡 提示: 请稍后重试\n`;
        } else {
          const detailMessage =
            responseData?.error?.message || responseData?.message || error.message;
          errorMessage = `\n❌ API 错误 (${status}): ${detailMessage}\n💡 提示: 请检查网络连接和 API 配置\n`;
        }

        yield errorMessage;
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('📋 非 Axios 错误:', errorMessage);
        yield `\n❌ 系统错误: ${errorMessage}\n💡 提示: 请检查服务配置和网络连接\n`;
      }
    }
  }
}
