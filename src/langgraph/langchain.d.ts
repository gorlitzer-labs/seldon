// Ambient module declarations for optional @langchain/* dependencies.
// These are dynamically imported at runtime and validated in start().
// The stubs let the DTS build succeed without the packages installed.

declare module "@langchain/langgraph" {
  export const StateGraph: any;
  export const MemorySaver: any;
  export const MessagesValue: any;
  export const StateSchema: any;
  export const START: any;
  export const END: any;
}

declare module "@langchain/langgraph/prebuilt" {
  export const ToolNode: any;
}

declare module "langchain/chat_models/universal" {
  export function initChatModel(...args: any[]): any;
}

declare module "@langchain/mcp-adapters" {
  export const MultiServerMCPClient: any;
}

declare module "@langchain/core/messages" {
  export const HumanMessage: any;
  export const SystemMessage: any;
}
